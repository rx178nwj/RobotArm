# 制御アプリ・モニタアプリIPC中継 要求仕様書

RobotArm2 の**制御アプリ**（SteppingMotorDriverへのモーション制御コマンドをUSB-CDC専有で発行する
新規デスクトップアプリ）と、**モニタアプリ**（`robot_arm_monitor`）が制御アプリへ操作を中継する
ローカルIPCプロトコルの要求仕様書。

| 項目 | 内容 |
|------|------|
| 対象 | 制御アプリ（新規、本書で新設）／`robot_arm_monitor`（モニタアプリ側のIPCクライアント実装） |
| 関連（外部） | [design/SYSTEM_REQUIREMENTS.md](SYSTEM_REQUIREMENTS.md) §4（通信アーキテクチャ方針、本書が解消する§6 #2の出典）・§6 #2/#5 |
| 関連（外部） | [robot_arm_monitor/REQUIREMENTS.md](../robot_arm_monitor/REQUIREMENTS.md) §4.4 F-RAM-CTRL（本書が実装する中継方式の消費側要件） |
| 関連（外部） | [robot_arm_monitor/docs/design_spec.md](../robot_arm_monitor/docs/design_spec.md) §3.5（`ControlAppClient`暫定インタフェース、本書で正式化） |
| 関連（外部） | [SteppingMotorDriver/firmware/REQUIREMENTS.md](../SteppingMotorDriver/firmware/REQUIREMENTS.md) §4（制御アプリがUSB-CDC経由で発行するコマンドセットの唯一の正） |
| 版 | 0.2（テレメトリ中継を追加、§4.5・2026-08-09） |
| 作成日 | 2026-07-26 |

---

## 1. 概要・位置づけ

### 1.1 目的

[design/SYSTEM_REQUIREMENTS.md §4](SYSTEM_REQUIREMENTS.md) の確定方針により、SteppingMotorDriverへの
USB-CDC接続は制御アプリが専有し、モニタアプリは直接接続を持たない。そのため
モニタアプリのモーション制御パネル（`robot_arm_monitor/REQUIREMENTS.md` F-RAM-CTRL）は、実際の
コマンド発行を**ローカルIPC経由で制御アプリへ中継**する（F-RAM-CTRL-00）。**2026-08-09以降は
テレメトリ（軸状態・位置・エンコーダ・電流電圧・関節角度・ギア角度）も同じIPC経由で制御アプリから
モニタアプリへ中継する**（§4.5、旧方式のBluetooth直接接続を置き換え）。

本書はこのIPC中継の**プロトコル・接続方式・コマンドマッピング・テレメトリ中継**を定義し、
[design/SYSTEM_REQUIREMENTS.md §6 #2](SYSTEM_REQUIREMENTS.md) を解消する。

### 1.2 スコープ

本書が定義するのは以下のみ：

- 制御アプリのIPCサーバとしての振る舞い（本書§3〜§5）
- モニタアプリのIPCクライアントとしての振る舞い（`ControlAppClient`、本書§5）
- IPC経由で中継されるコマンドの範囲とマッピング（本書§4）

**本書がスコープ外とするもの**（別途要件化が必要）：

- 制御アプリ自身のGUI設計（ジョグ操作パネル、軸パラメータ編集画面等の画面構成）
- 制御アプリのSteppingMotorDriverへのUSB-CDC接続管理の詳細UX（`multi_i2c_bridge`/`robot_arm_monitor`の
  既存パターン「候補ポート選択→接続」を踏襲する想定だが、詳細は制御アプリ自身の要求仕様書で定義する）
- 制御アプリ単体でのパラメータ設定・NVS操作等（[firmware/REQUIREMENTS.md §4.4](../SteppingMotorDriver/firmware/REQUIREMENTS.md)
  の設定コマンド群を制御アプリがどこまでGUI化するかは制御アプリ側の要求仕様書で定義する）

これらは制御アプリの新規要求仕様書（未作成）で別途定義し、本書は**IPC中継プロトコルの契約**にのみ責任を持つ。

---

## 2. システム構成（[design/SYSTEM_REQUIREMENTS.md §3/§4](SYSTEM_REQUIREMENTS.md)より抜粋）

```
        モニタアプリ（robot_arm_monitor）        制御アプリ（新規）
        ┌───────────────────────┐ ローカルIPC(コマンド+テレメトリ) ┌───────────────────────┐
        │ ControlAppClient      │◄───────(本書§3・§4.5)──────────►│ IPC Server            │
        └────────────────────────┘                              └──────┬────────────────┘
                                                                        │USB-CDC(専有)
                                                                        ▼
                                                                 SteppingMotorDriver0-2
```

- モニタアプリ・制御アプリは**同一PC上で動作する別プロセス**（同一ホスト、ネットワーク越しの通信は想定しない）。
- 制御アプリは起動時にIPCサーバを開始し、SteppingMotorDriverへのUSB-CDC接続とは独立してIPCサーバを
  待ち受け続ける（USB未接続でもIPCサーバ自体は起動できる。個別コマンド実行時にUSB未接続なら
  `ERR NOT_CONNECTED`相当を返す、§4.4）。
- モニタアプリは起動時・設定変更時にIPC接続を試行し、切断時は自動再接続する（§5.3）。

---

## 3. IPCトランスポート（確定）

### 3.1 採用方式：Windows Named Pipe

| 項目 | 採用 | 理由 |
|------|------|------|
| トランスポート | Windows Named Pipe（`\\.\pipe\robotarm-control-app`） | 対象OSがWindows 10/11のみ（両アプリ共通、`robot_arm_monitor/REQUIREMENTS.md` §5）。TCPループバックより単純な権限モデルで、他プロセスからの誤接続（意図しないポートスキャン等）のリスクが低い。Node.js（`net.createServer({ path: ... })`）・Electronの双方から標準APIで扱える |
| パイプ名 | `\\.\pipe\robotarm-control-app`（固定、バージョン変更等で変える場合は末尾にバージョン番号を付与） | 両アプリで固定文字列として共有する。設定ファイル化はしない（過剰設計を避ける、両アプリが同一リポジトリ内で開発されるため文字列の同期は容易） |
| 認証 | なし（ローカルホスト内のみで完結する接続のため、追加の認証機構は導入しない） | ネットワーク越しの接続を想定しないスコープ（§1.1）。将来リモート監視要件が生じた場合は別途認証を要件化する |
| 同時接続数 | 1（モニタアプリの1インスタンスのみを許容） | 複数モニタアプリインスタンスからの同時操作は競合リスクがあるため許容しない。2本目の接続要求は拒否する |

### 3.2 フレーム形式

改行区切りJSONテキスト（`\n`終端）。`multi_i2c_bridge`のUSBシリアルプロトコル・
SteppingMotorDriverのBLE/WiFiテレメトリ（[BLE_WIFI_REQUIREMENTS.md §5.3](../SteppingMotorDriver/firmware/BLE_WIFI_REQUIREMENTS.md)）
と同様の「改行区切りJSON」パターンを踏襲し、実装の一貫性を保つ。

```
→ {"id":1,"type":"command","boardId":"AABBCCDDEEFF","axis":0,"command":"ENABLE"}\n
← {"id":1,"type":"result","ok":true}\n

→ {"id":2,"type":"command","boardId":"AABBCCDDEEFF","axis":0,"command":"MOVE","args":[1000]}\n
← {"id":2,"type":"result","ok":false,"error":"E008","message":"MOTION_IN_PROGRESS"}\n

→ {"id":3,"type":"estop"}\n
← {"id":3,"type":"estop_result","results":[{"boardId":"AABBCCDDEEFF","ok":true},{"boardId":"112233445566","ok":false,"error":"NOT_CONNECTED"}]}\n
```

- `id`：リクエスト側が採番するリクエストID（連番、レスポンスと突合するため）。
- 通常コマンドは1リクエスト=1レスポンス（同期的な応答）。制御アプリ側でUSB応答（`OK`/`ERR`、
  [firmware/REQUIREMENTS.md §4.1](../SteppingMotorDriver/firmware/REQUIREMENTS.md)）を待ってから
  IPCレスポンスを返す。
- 接続状態変化（制御アプリ側のUSB接続断等）は、制御アプリからモニタアプリへの非同期通知
  （`type: "connection_changed"`）として送る（§5.2）。

---

## 4. コマンドマッピング

### 4.1 アドレス指定方式（確定：基板固有ID＋ローカル軸番号）

IPCリクエストは**論理軸番号ではなく、基板固有ID（factory MAC）＋ローカル軸番号（0-2）**で対象を
指定する。理由：

- 論理軸⇔基板/ローカル軸の対応表（`robot_arm_monitor/docs/design_spec.md` §5 `axis-mapping.ts`）は
  モニタアプリ側の設定であり、制御アプリはこれを知る必要がない（制御アプリの責務をSteppingMotorDriver
  との直接通信のみに限定し、軸マッピングの知識をモニタアプリ側に閉じ込める、既存の関心分離方針を踏襲）。
- 制御アプリが複数のモニタアプリ的なクライアントから将来利用される場合にも、基板固有ID基準のアドレス
  指定なら軸マッピング設定に依存しない。

モニタアプリ側（`device-manager.ts`）は、論理軸番号からIPCリクエスト送信前に基板固有ID＋ローカル軸へ
変換する（`axis-mapping.ts`の対応表を使用）。

### 4.2 中継するコマンド（[firmware/REQUIREMENTS.md §4.2](../SteppingMotorDriver/firmware/REQUIREMENTS.md)に1:1対応）

| IPC `command` | 引数（`args`） | 対応する実機コマンド | 備考 |
|---------------|---------------|----------------------|------|
| `ENABLE` | - | `ENABLE <axis>` | |
| `DISABLE` | - | `DISABLE <axis>` | |
| `STOP` | - | `STOP <axis>` | |
| `STOP_FREE` | - | `STOP_FREE <axis>` | |
| `CLEAR_FAULT` | - | `CLEAR_FAULT` | 軸単位ではなく基板単位（実機コマンドが全軸一括のため、`axis`は無視してよい） |
| `HOME` | - | `HOME <axis>` | 完了は`EVT HOME_DONE`、§4.3参照 |
| `MOVE` | `[steps]` | `MOVE <axis> <steps>` | |
| `MOVETO` | `[pos]` | `MOVETO <axis> <pos>` | |
| `VEL` | `[speed]` | `VEL <axis> <speed>` | ジョグ操作はこのコマンドを継続発行する想定（[robot_arm_monitor/REQUIREMENTS.md F-RAM-CTRL-01〜06](../robot_arm_monitor/REQUIREMENTS.md)のジョグ操作） |
| `SYNC_MOVE` | `[[axis0,steps0],[axis1,steps1],...]` | `SYNC_MOVE <n> <ax0> <st0>...` | 同一基板内の複数軸を指定。基板をまたぐ同期移動は本書では扱わない（実機コマンド自体が単一基板内のみのため） |
| `MOVE_DEG` | `[deg]` | `MOVE_DEG <axis> <deg>` | 相対移動（度単位、[firmware/REQUIREMENTS.md F-MOT-12](../SteppingMotorDriver/firmware/REQUIREMENTS.md)）。[robot_arm_monitor/REQUIREMENTS.md F-RAM-VERIFY](../robot_arm_monitor/REQUIREMENTS.md)の関節検証パネルが使用 |
| `MOVETO_DEG` | `[deg]` | `MOVETO_DEG <axis> <deg>` | 絶対位置移動（度単位、同上） |
| `POT_ZERO_SET` | - | `SET POT_ZERO <axis>` | POTゼロ位置補正（現在値を記録、不可逆操作。同上F-RAM-VERIFY） |
| `POT_ZERO_CLEAR` | - | `CLEAR POT_ZERO <axis>` | POTゼロ位置補正のクリア（同上） |

- `ESTOP`は上記の個別コマンドとは別枠（`type: "estop"`、引数なし、対象基板を指定しない）。制御アプリが
  **接続中の全SteppingMotorDriver基板**へ同時にESTOPを発行し、基板ごとの結果を集約して返す
  （[robot_arm_monitor/REQUIREMENTS.md F-RAM-CTRL-01〜06](../robot_arm_monitor/REQUIREMENTS.md)の全停止集約操作、§6参照）。

### 4.3 非同期イベントの扱い

[firmware/REQUIREMENTS.md §4.5](../SteppingMotorDriver/firmware/REQUIREMENTS.md)の`EVT`群
（`HOME_DONE`/`STALL_FAULT`/`OVERCURRENT`/`MOVE_DONE`/`SYNC_DONE`等）は、制御アプリが受信した USB
イベントをそのまま IPC 経由でモニタアプリへ非同期通知として転送する：

```
← {"type":"event","boardId":"AABBCCDDEEFF","event":"HOME_DONE","axis":0}\n
← {"type":"event","boardId":"AABBCCDDEEFF","event":"STALL_FAULT","axis":1}\n
```

モニタアプリはこれをイベントログ（[robot_arm_monitor/REQUIREMENTS.md](../robot_arm_monitor/REQUIREMENTS.md)
既存のイベントログパネル相当）に表示する。**この非同期イベント転送は読み取り専用のテレメトリ拡張であり、
BLE経由のテレメトリ（10Hz周期の状態値）を補完するものであって、モーション制御コマンドの発行経路では
ない**（§1.2の書き込み系はコマンド発行方向のみ）。

### 4.4 エラー・タイムアウト

- 制御アプリが対象基板とUSB接続していない場合：`{"ok":false,"error":"NOT_CONNECTED"}`
- 実機からの`ERR <code> <message>`はそのまま`{"ok":false,"error":"<code>","message":"<message>"}`として
  中継する（[firmware/REQUIREMENTS.md §4.6](../SteppingMotorDriver/firmware/REQUIREMENTS.md)のエラー
  コード表をそのまま透過する。制御アプリ側でエラーコードの意味を再解釈・変換しない）。
- 制御アプリ側のコマンドタイムアウト（実機無応答）は5000ms（[firmware/REQUIREMENTS.md](../SteppingMotorDriver/firmware/REQUIREMENTS.md)
  の`SET COMM_TIMEOUT`デフォルト値に合わせる）とし、タイムアウト時は`{"ok":false,"error":"TIMEOUT"}`を返す。

### 4.5 テレメトリ中継（2026-08-09新設）

[design/SYSTEM_REQUIREMENTS.md §4](SYSTEM_REQUIREMENTS.md) の2026-08-09改訂により、モニタアプリの
SteppingMotorDriverテレメトリ取得経路をBluetooth直接接続からUSB-CDC（本書のIPC中継）へ変更した。
旧BLEテレメトリサービス（[BLE_WIFI_REQUIREMENTS.md](../SteppingMotorDriver/firmware/BLE_WIFI_REQUIREMENTS.md)）
が提供していた全フィールドは、[firmware/REQUIREMENTS.md §4.3](../SteppingMotorDriver/firmware/REQUIREMENTS.md)の
既存USB-CDC状態取得コマンドの組み合わせで再現できるため、**ファームウェア変更は不要**。

**ポーリング方式：** 制御アプリは、USB-CDC接続中の各SteppingMotorDriver基板ごとに、既定1000ms間隔で
以下のGETコマンド列を順次発行し（モーションコマンドと同じ`BoardConnection`の直列キューに乗せる）、
1周期分の結果をまとめてIPCクライアントへ非同期送信する：

| 対応フィールド | 発行するUSB-CDCコマンド |
|---|---|
| axes（axis/state/pos/vel/enc） | `GET STATE <axis>`,`GET POS <axis>`,`GET VEL <axis>`,`GET ENC <axis>` ×3軸 |
| power（pot[3]/current_mA/voltage_mV） | `GET ADC 0`,`GET ADC 1`,`GET ADC 2`,`GET ADC 3`（×1000でmV換算）,`GET ADC 4` |
| fault（reason/axis_mask/timestamp_us） | `GET FAULT_INFO` |
| jointAngle（posDeg/encDeg/potDegRaw/potDegZeroed） | `GET POS_DEG <axis>`,`GET ENC_DEG <axis>`,`GET POT_DEG <axis>` ×3軸 |
| gear（axis/angleDeg/state/deviationDeg） | `GET GEAR_STATUS`（全軸一括） |

**フレーム形式：** IPC経由で以下の非同期フレームをモニタアプリへ送信する（`id`は付与しない、コマンド
応答とは独立した非同期通知）：

```
← {"type":"telemetry","boardId":"AABBCCDDEEFF","axes":[...],"power":{...},"fault":{...},"gear":[...],"jointAngle":[...]}\n
```

- `axes`/`jointAngle`/`gear`はUSB-CDCから取得した値をそのままJSON化したもの（フィールド名はモニタアプリ
  側`MotorSnapshot`の対応する型と1:1、camelCase）。
- 1基板あたり1周期で計20コマンドの往復が発生する（軸3・チャンネル5・全軸一括コマンドの内訳は上表参照）。
  ポーリング間隔はモーションコマンドの応答性とのトレードオフであり、実機確認後にチューニング可能な
  定数として実装する（既定値1000ms）。
- GETコマンドはファームウェアの同時コマンドポリシー上、モーション実行中でも常に受理される
  （[firmware/REQUIREMENTS.md](../SteppingMotorDriver/firmware/REQUIREMENTS.md)の同時コマンドポリシー表）
  ため、テレメトリポーリングとモーション制御コマンドの同一キュー共有は安全である。

---

## 5. 接続ライフサイクル

### 5.1 モニタアプリ側（`ControlAppClient`、[design_spec.md §3.5](../robot_arm_monitor/docs/design_spec.md)の正式化）

```typescript
// src/main/adapters/control-app-client.ts
export interface ControlAppClient extends EventEmitter {
  readonly connected: boolean;
  sendCommand(boardId: string, axis: number, command: string, args?: unknown[]): Promise<CommandResult>;
  sendEstop(): Promise<EstopResult>;
  on(event: "connectionChanged", listener: (connected: boolean) => void): this;
  on(event: "controlEvent", listener: (e: { boardId: string; event: string; axis?: number }) => void): this;
  on(event: "telemetry", listener: (snapshot: MotorSnapshot) => void): this; // §4.5
}
```

- 起動時にNamed Pipeへの接続を試行する。失敗時（制御アプリ未起動）は一定間隔（既定3秒）でリトライする。
- 接続確立後、切断を検知したら`connectionChanged(false)`をemitし、`robot_arm_monitor/REQUIREMENTS.md
  F-RAM-CTRL-00`の方針どおり操作パネルを全て無効化する。切断後も同様にリトライを継続する。

### 5.2 制御アプリ側（IPCサーバ、本書で新設する要件）

- 起動時にNamed Pipeサーバを開始する。モニタアプリが未接続でも制御アプリ自体は通常動作する
  （制御アプリは自分自身のGUIからも直接コマンドを発行できる想定、§1.2でスコープ外とした制御アプリ
  自身のGUI要件による）。
- 2本目のIPC接続要求は拒否する（§3.1）。
- USB接続状態が変化した場合（基板の接続/切断）、接続中のIPCクライアントへ`connection_changed`相当の
  通知を送る（制御アプリ自体の接続状態ではなく、配下のSteppingMotorDriver基板の接続状態変化。
  型は本書§3.2のフレーム形式に準拠して実装時に定義する）。

### 5.3 残存安全リスク（[design/SYSTEM_REQUIREMENTS.md §6 #5](SYSTEM_REQUIREMENTS.md)、変更なし）

**ESTOPも本IPC経由の中継のみを通る。** 制御アプリが未起動・無応答の場合、モニタアプリからのESTOPも
実行できない。本書はこの残存安全リスクを解消するものではなく、[design/SYSTEM_REQUIREMENTS.md §4](SYSTEM_REQUIREMENTS.md)
で確定済みの「無線への書き込み例外は設けない」方針の帰結として引き続き記録する。

---

## 6. 全停止（ESTOP）集約操作の詳細

[robot_arm_monitor/REQUIREMENTS.md §4.4](../robot_arm_monitor/REQUIREMENTS.md)の「接続中の全
SteppingMotorDriver基板へ同時にESTOPを発行する」操作は、制御アプリ側で以下のように実装する：

1. モニタアプリから`{"type":"estop"}`を受信する。
2. 制御アプリが現在USB接続している**全**SteppingMotorDriver基板（複数枚）に対し、同時に`ESTOP`
   コマンドを送信する（順次ではなく並行送信し、全体の発行完了までのレイテンシを最小化する）。
3. 各基板の`OK`/`ERR`/タイムアウトを集約し、`estop_result`として基板ごとの結果を返す。
4. 一部基板が無応答でも、応答があった基板へのESTOP発行は独立して成功させる（1基板の異常が他基板の
   緊急停止をブロックしない）。

---

## 7. 非機能要件

| 項目 | 要件 |
|------|------|
| 信頼性 | IPC切断・再接続で制御アプリ・モニタアプリのいずれもクラッシュしないこと |
| レイテンシ | ESTOP中継は制御アプリ受信から全基板への送信開始まで50ms以内を目標とする（実機評価は制御アプリ実装Phaseで実施） |
| 対象OS | Windows 10/11のみ（両アプリ共通方針） |
| セキュリティ | ローカルNamed Pipeのみ、ネットワーク越しの接続は提供しない（§3.1） |

---

## 8. 未解決事項

| # | 項目 | 優先度 | 備考 |
|---|------|--------|------|
| 1 | 制御アプリ自身の要求仕様書（GUI構成、USB接続管理UX、パラメータ設定範囲）が未作成 | High | 本書§1.2でスコープ外とした部分。robot_arm_monitor Phase7着手前、または並行して作成する必要がある |
| 2 | Named Pipeの接続可否をアプリ間でどう初回検知するか（制御アプリ未インストール環境の扱い） | Medium | モニタアプリ単体運用（bridge監視のみ）のユーザーも想定されるため、制御アプリ未検出時のUI表現を要検討 |
| 3 | 複数モニタアプリ的クライアントからの同時利用要否 | Low | 現状は単一クライアントのみ許容（§3.1）。将来要件化の可能性を残す |
| 4 | ESTOP集約のレイテンシ目標（50ms）の妥当性 | Medium | 実機評価が必要、robot_arm_monitor Phase7〜8実装時に検証 |

本書により [design/SYSTEM_REQUIREMENTS.md §6 #2](SYSTEM_REQUIREMENTS.md) はクローズとするが、
上記#1（制御アプリ自身の要求仕様書）が別途必要である点は新たな未解決事項として記録する。
