# ロボットアーム統合モニタ 実装仕様書

[../REQUIREMENTS.md](../REQUIREMENTS.md) の要件を実現するための実装アーキテクチャ・データモデル・移行方針。

| 項目 | 内容 |
|------|------|
| 関連 | [../REQUIREMENTS.md](../REQUIREMENTS.md)（要件定義の正） |
| 版 | 0.1（初版） |
| 作成日 | 2026-07-25 |
| 実装状況 | Phase 1〜2実装済み |

---

## 1. 実装アーキテクチャ（前提）

| 項目 | 選定 | 根拠 |
|------|------|------|
| フレームワーク | Electron | 既存2アプリと同一、資産流用のため |
| 言語 | TypeScript | [multi_i2c_bridge/monitor_app](../../multi_i2c_bridge/monitor_app/) が既にTS化済み。[SteppingMotorDriver/monitor_app](../../SteppingMotorDriver/monitor_app/) はJSだが、移植時にTS化する（型でプロトコル差異を明示するため） |
| シリアル通信 | Node `serialport`（メインプロセス、multi_i2c_bridge向け） | 既存2アプリと同一 |
| Bluetooth通信 | BLEクライアントライブラリ（メインプロセス、SteppingMotorDriver向け、選定は§8未解決事項） | [design/IF_design.drawio](../../design/IF_design.drawio)確定：モニタアプリ⇔SteppingMotorDriverは読み取り専用Bluetooth（§9） |
| チャート描画 | uPlot | [SteppingMotorDriver/monitor_app](../../SteppingMotorDriver/monitor_app/) の採用実績を踏襲（[REQUIREMENTS.md §8 未解決事項#4](../REQUIREMENTS.md)で解決済み） |
| プロセス構成 | メインプロセスがデバイス列挙・シリアルI/O・パースを担当。レンダラーはIPC経由でパース済み正規化データのみ受信 | 既存2アプリと同一方針（生シリアルデータをレンダラーに流さない） |
| 対象OS | Windows 10/11 | [REQUIREMENTS.md §5](../REQUIREMENTS.md) |

---

## 2. ディレクトリ構成

```
robot_arm_monitor/
├── REQUIREMENTS.md
├── docs/
│   └── design_spec.md（本書）
├── package.json
├── tsconfig.json
├── src/
│   ├── main/
│   │   ├── main.ts                      # エントリポイント、IPCハンドラ登録
│   │   ├── device-manager.ts            # 種別混在デバイスの列挙・接続ライフサイクル管理
│   │   ├── adapters/
│   │   │   ├── device-adapter.ts        # 共通インタフェース定義（§3.1）
│   │   │   ├── stepping-motor-ble-adapter.ts # SteppingMotorDriver向け実装（§3.2、BLE読み取り専用テレメトリ、新規実装）
│   │   │   ├── multi-i2c-bridge-adapter.ts # multi_i2c_bridge向け実装（§3.3、device-session.ts移植）
│   │   │   └── control-app-client.ts    # 制御アプリへのIPC中継クライアント（§3.5、F-RAM-CTRL-00）
│   │   ├── axis-mapping.ts              # 論理軸(動的N軸、最大12)⇔基板/ローカルch対応表の永続化（§5）
│   │   └── preload.ts
│   ├── renderer/
│   │   ├── index.html
│   │   ├── dashboard.ts                 # F-RAM-DASH 統合ダッシュボード
│   │   ├── axis-detail.ts               # F-RAM-DASH-02 軸詳細画面
│   │   ├── board-view.ts                # F-RAM-DASH-03 基板単位ビュー
│   │   ├── mapping-settings.ts          # F-RAM-MAP 軸マッピング設定UI
│   │   ├── trend-charts.ts              # F-RAM-GRAPH（SteppingMotorDriver/monitor_app由来を拡張）
│   │   └── styles.css
│   └── shared/
│       └── types.ts                     # 共通データモデル（§4）
└── test/
```

---

## 3. デバイスアダプタ層

種別ごとのプロトコル差異を吸収し、上位（device-manager・renderer）へは共通の正規化スナップショットのみを渡す。[REQUIREMENTS.md §5](../REQUIREMENTS.md)「保守性」要件（片方の仕様変更が他方に影響しない）を満たすための中核設計。

### 3.1 共通インタフェース

```typescript
// src/main/adapters/device-adapter.ts
export type DeviceKind = "stepping_motor_driver" | "multi_i2c_bridge";
export type ConnectionState = "disconnected" | "connecting" | "monitoring" | "timeout" | "error";

export interface DeviceIdentity {
  kind: DeviceKind;
  boardId: string;        // factory MAC（motor） or 永続基板ID（bridge）
  protocolVersion?: string;
}

export interface DeviceAdapter extends EventEmitter {
  readonly kind: DeviceKind;
  readonly boardId: string;
  connect(path: string, periodMs: number): Promise<void>;
  disconnect(): void;
  sendCommand(command: string): void;        // 生コマンド発行（F-RAM-CTRL等の個別操作から利用）
  // "update" イベントで種別ごとの正規化スナップショット（§4）を emit する
}

// 種別判別（F-RAM-CONN-01、確定）
export interface IdentityProbe {
  probe(path: string): Promise<DeviceIdentity | null>;
}

// VIDによる一次分類（探索順序の最適化のみ、確定判定には使わない）
export const VID_HINT: Record<string, DeviceKind> = {
  "303a": "stepping_motor_driver", // Espressif（ESP32-S3内蔵USB Serial/JTAG既定VID）
  "2e8a": "multi_i2c_bridge",      // Raspberry Pi Trading（arduino-picoコア既定VID）
};
```

- `device-manager.ts` は `serialport.list()` のポート一覧を `VID_HINT` で一次分類し、ヒントに従って `IdentityProbe`（motor用: `PING`→`GET BOARD_ID`、bridge用: `identity`）を優先順に試行する。ヒントが外れていた場合（VIDは一致するが識別コマンドが無応答/不一致）はもう一方のプロトコルへフォールバックする。VIDが `VID_HINT` に存在しないポートは自動判別対象外とし、手動ポート指定導線（既存2アプリの方針を踏襲）でのみ接続可能とする。
- 将来的にプロトコルが変わってもアダプタ内部の実装のみ変更すればよく、`DeviceAdapter` インタフェースと `device-manager.ts` 側は変更不要とする。

### 3.2 StepBleAdapter（SteppingMotorDriver、読み取り専用テレメトリ）

**[design/IF_design.drawio](../../design/IF_design.drawio)確定により、トランスポートはUSBではなくBluetoothとなる。** [SteppingMotorDriver/monitor_app/src/main/serial-session.js](../../SteppingMotorDriver/monitor_app/src/main/serial-session.js) の通信層（`SerialPort`ベース）はそのまま移植できないため、本アダプタは新規実装とする。

- **未確定・外部依存**（[design/SYSTEM_REQUIREMENTS.md §6 #1](../../design/SYSTEM_REQUIREMENTS.md)）：SteppingMotorDriverファームウェア側にBLEテレメトリサービス（GATT）が未実装。本アダプタの実装はファームウェア側のGATT仕様確定後に着手する。
- 想定するデータ内容は既存の`STATUS`コマンドのJSON構造（[firmware/REQUIREMENTS.md §4](../../SteppingMotorDriver/firmware/REQUIREMENTS.md)）を踏襲する想定だが、BLEの1パケットサイズ制約（ATU、既定23〜247byte程度）によりJSON全体を1通知に収められない場合は分割・再構成が必要になる可能性がある（ファームウェア側GATT設計時に確定）。
- **書き込み系コマンド（ENABLE/MOVE/HOME等）は本アダプタでは発行しない**（読み取り専用、[REQUIREMENTS.md §7.1](../REQUIREMENTS.md)）。`sendCommand`は`DeviceAdapter`インタフェース上は存在するが、本アダプタでは呼び出されない想定（呼び出された場合はエラーとする）。
- 識別：`GET BOARD_ID`相当の情報をBLEアドバタイズ名またはGATT特性から取得する方式は未定（[design/SYSTEM_REQUIREMENTS.md §6 #3](../../design/SYSTEM_REQUIREMENTS.md)、Bluetoothデバイス検出・ペアリングUX未検討）。

### 3.3 BridgeAdapter（multi_i2c_bridge）

- 移植元：[multi_i2c_bridge/monitor_app/src/main/device-session.ts](../../multi_i2c_bridge/monitor_app/src/main/device-session.ts)・`parser.ts`・`port-identity.ts`
- プロトコル：`identity`/`status`/`channels`/`config`/`master`/`log`/`monitor <period>`、[usb_serial_spec.md §4](../../multi_i2c_bridge/docs/usb_serial_spec.md)準拠。
- 既存 `DeviceSession` クラス（`EventEmitter` 継承、`connect`/`startMonitor`/`stopMonitor`/`disconnect`/`emitUpdate` 構成）をほぼそのまま `DeviceAdapter` インタフェースに適合させる形で移植する。
- 識別：`identity` コマンドの永続基板ID。

### 3.4 device-manager.ts

- 接続中の全アダプタ（種別混在）を `Map<boardId, DeviceAdapter>` で保持。
- 各アダプタの `update` イベントを購読し、`axis-mapping.ts`（§5）で論理軸へマッピングした上でレンダラーへIPC送信する。
- F-RAM-CTRL-05（全停止集約）：接続中の全論理軸へ `ESTOP` 中継リクエストを同時発行するメソッドを提供（実行は§3.5経由）。

### 3.5 ControlAppClient（制御アプリへのIPC中継、F-RAM-CTRL-00）

- **未確定・外部依存**（[design/SYSTEM_REQUIREMENTS.md §6 #2](../../design/SYSTEM_REQUIREMENTS.md)）：制御アプリ本体・IPCプロトコルが未設計のため、本クライアントの実装は制御アプリ側の仕様確定後に着手する。
- 想定インタフェース（暫定、制御アプリ側仕様確定後に差し替え）：

```typescript
// src/main/adapters/control-app-client.ts（暫定インタフェース）
export interface ControlAppClient {
  readonly connected: boolean;         // 制御アプリのIPC接続状態
  sendMotionCommand(axis: string, command: string, args?: unknown): Promise<{ ok: boolean; error?: string }>;
  sendEstop(): Promise<{ ok: boolean; error?: string }>;
  // "connectionChanged" イベントで接続状態変化を通知（F-RAM-CTRL-00: 未接続時はUI無効化）
}
```

- `device-manager.ts` は `ControlAppClient.connected` を監視し、`false` の間はF-RAM-CTRL関連のIPCハンドラを「操作不可」応答にする（レンダラー側の操作パネルはこれを見てグレーアウトする）。
- `ESTOP`も本クライアント経由の中継のみであり、独立したフェイルセーフ経路は持たない（[design/SYSTEM_REQUIREMENTS.md §6 #5](../../design/SYSTEM_REQUIREMENTS.md)の残存安全リスクとして記録済み、本書では追加の緩和策を設計しない）。

---

## 4. 共通データモデル（IPC/レンダラー向け）

```typescript
// src/shared/types.ts

export interface AxisSnapshot {
  axisId: number | null;    // 論理軸番号（1〜12、接続構成に応じ動的。null = 未割当）
  axisLabel: string;        // ユーザー設定表示名（例："J1"）。固定enumにしない（§3.2 REQUIREMENTS.md）
  motor?: {
    boardId: string;
    localAxis: number;           // 0-2
    state: "IDLE" | "SLEEP" | "ACCEL" | "CRUISE" | "DECEL" | "HOMING" | "FAULT";
    stepPos: number;
    encoderPos: number;
    deviation: number;
    velocity: number;
    currentMa: number;
    voltageV: number;
  };
  gearRelayed?: {                // SteppingMotorDriver経由の中継値（F-RAM-GEAR-01）
    boardId: string;
    angleDeg: number | null;
    status: "OK" | "DEGRADED" | "UNAVAILABLE";
    deviationDeg: number | null;
  };
  gearDirect?: {                 // bridge直接接続時の生値（F-RAM-GEAR-02）
    boardId: string;
    localChannel: number;        // 0-2 (通常)
    angleDeg: number | null;
    ok: boolean;
    agc: number;
  };
  gearMismatch?: {                // F-RAM-GEAR-03 突合結果
    diffDeg: number;
    exceeded: boolean;            // 閾値超過フラグ
  };
}

export interface BoardConnectionState {
  boardId: string;
  kind: "stepping_motor_driver" | "multi_i2c_bridge";
  path: string;
  state: "disconnected" | "connecting" | "monitoring" | "timeout" | "error";
  label: string;                  // ユーザー設定表示名
  error?: string;
}

export interface RobotArmSnapshot {
  axes: AxisSnapshot[];           // 要素数=接続構成に応じた動的軸数（最大12）、未割当はaxisIdフィールドで判別
  boards: BoardConnectionState[];
  controlAppConnected: boolean;   // ControlAppClient接続状態（§3.5、F-RAM-CTRL-00）
  timestamp: number;
}
```

- `RobotArmSnapshot` は `device-manager.ts` が各アダプタの生スナップショットと `axis-mapping.ts` の対応表から都度合成し、IPC (`ipcMain.emit` 経由) でレンダラーへ送る。
- 個別基板の生データ（既存2アプリ相当のパネル、F-RAM-DASH-03）が必要な画面では、`BoardConnectionState.boardId` をキーに、アダプタ種別ごとの生スナップショット（motor用JSON、bridge用 `ChannelData[]` 等、multi_i2c_bridgeの `src/shared/types.ts` 相当）を別チャネルで取得する。

---

## 5. 軸マッピング設定の永続化（F-RAM-MAP）

`electron-store` を採用する（[SteppingMotorDriver/monitor_app/REQUIREMENTS.md 7.4](../../SteppingMotorDriver/monitor_app/REQUIREMENTS.md)の採用実績・理由を踏襲：単純なキー・バリュー設定でありフルDB不要）。

```jsonc
// electron-store スキーマ例（軸キーは固定enumではなく動的な論理軸番号1〜12、REQUIREMENTS.md §3.2）
{
  "axisMapping": {
    "1": { "label": "J1", "motorBoardId": "AA:BB:CC:DD:EE:01", "motorLocalAxis": 0, "bridgeBoardId": "3E3FD41AF8EF45FB", "bridgeLocalChannel": 0 },
    "2": { "label": "J2", "motorBoardId": "AA:BB:CC:DD:EE:01", "motorLocalAxis": 1, "bridgeBoardId": "3E3FD41AF8EF45FB", "bridgeLocalChannel": 1 }
    // ... 軸3〜12（実際の接続基板数に応じ可変、最大4+4基板=12軸）
  },
  "boardLabels": { "AA:BB:CC:DD:EE:01": "Board A (J1-J3)", "3E3FD41AF8EF45FB": "Bridge 1 (J1-J3 gear)" },
  "pollingMs": { "motor": 100, "bridge": 100 },
  "gearMismatchThresholdDeg": 1.0,
  "gearMismatchCheckWhenMoving": false,
  "graphWindowSeconds": 60
}
```

- `pollingMs.bridge` は [usb_serial_spec.md §4.7](../../multi_i2c_bridge/docs/usb_serial_spec.md) の `monitor` コマンド受理下限（100ms）を採用する（[REQUIREMENTS.md F-RAM-GEAR-05](../REQUIREMENTS.md)）。multi_i2c_bridge単体アプリの既定値（1000ms）とは独立して本アプリ専用の設定とする。
- `gearMismatchCheckWhenMoving` は常に `false` 固定（軸状態がIDLEの時のみ突合判定、[REQUIREMENTS.md F-RAM-GEAR-03](../REQUIREMENTS.md)）。将来動的閾値方式に変更する場合のみ`true`運用を検討する。

- 基板固有ID（factory MAC / 永続基板ID）をキーとするため、COMポート変更後も設定が引き継がれる（[REQUIREMENTS.md F-RAM-CONN-02](../REQUIREMENTS.md)）。

---

## 6. UI構成（画面遷移）

```
robot_arm_monitor/
├── メイン画面（ダッシュボード, F-RAM-DASH-01）
│   ├── ヘッダー: 接続基板一覧 + 制御アプリ接続状態表示 + 全停止（ESTOP）ボタン（常時表示、制御アプリ未接続時は無効化＋警告表示、F-RAM-CTRL-00/05）
│   ├── 論理軸横断サマリーテーブル（軸数は接続構成に応じ可変・最大12、クリックで軸詳細へ）
│   └── グローバル操作: 全体monitor開始/停止、周期設定
├── 軸詳細画面（F-RAM-DASH-02）
│   ├── モーター側詳細（状態/位置/エンコーダ/偏差/電流/電圧、F-RAM-CTRL操作パネルは制御アプリ接続時のみ操作可）
│   ├── ギア角度パネル（中継値/直接値/突合結果、F-RAM-GEAR）
│   └── トレンドグラフ（F-RAM-GRAPH-01、5チャートグループ: 速度/位置・エンコーダ/偏差/電流・電圧/ギア角度、各最大4系列）
├── 軸横断比較ビュー（F-RAM-GRAPH-02、新規）
│   └── メトリック選択式チャート（接続中の論理軸を最大12系列で重畳表示）
├── 基板単位ビュー（F-RAM-DASH-03、デバッグ用）
│   ├── SteppingMotorDriver生データ（3軸分/枚、BLEテレメトリ、既存アプリ相当）
│   └── multi_i2c_bridge生データ（6ch分/枚、既存アプリ相当、channels/status/master）
├── 軸マッピング設定画面（F-RAM-MAP-01）
├── パラメータ設定画面（F-RAM-PARAM）
└── イベントログ／送受信ログパネル（開閉可能）
```

---

## 7. 既存コードからの移植方針

| 移植元 | 移植先 | 方針 |
|--------|--------|------|
| [SteppingMotorDriver/monitor_app/src/main/serial-session.js](../../SteppingMotorDriver/monitor_app/src/main/serial-session.js) | `src/main/adapters/stepping-motor-ble-adapter.ts` | 通信層（`SerialPort`）は移植不可（USB→BLEへトランスポート変更、§3.2）。`STATUS`のJSONパース処理のみ参考にできる。ファームウェア側BLE GATT仕様確定後に新規実装（[design/SYSTEM_REQUIREMENTS.md §6 #1](../../design/SYSTEM_REQUIREMENTS.md)） |
| [SteppingMotorDriver/monitor_app/src/renderer/trend-charts.js](../../SteppingMotorDriver/monitor_app/src/renderer/trend-charts.js) | `src/renderer/trend-charts.ts` | 既存の4チャートグループ構成（速度/位置・エンコーダ/偏差/電流・電圧）をそのまま流用し、ギア角度グループ（中継値・直接値・差分、最大4系列）を追加する。軸横断比較ビュー（F-RAM-GRAPH-02）用に、任意メトリック×最大12軸を1チャートに重畳するモードも同ファイルに追加する |
| [multi_i2c_bridge/monitor_app/src/main/device-session.ts](../../multi_i2c_bridge/monitor_app/src/main/device-session.ts) | `src/main/adapters/multi-i2c-bridge-adapter.ts` | `EventEmitter` 継承クラスをほぼそのまま流用、`DeviceAdapter` インタフェースのメソッド名に合わせて薄いラッパーを被せる |
| [multi_i2c_bridge/monitor_app/src/main/parser.ts](../../multi_i2c_bridge/monitor_app/src/main/parser.ts) | 同上ディレクトリへコピー | 行パーサはプロトコル固有ロジックのため変更不要 |
| [multi_i2c_bridge/monitor_app/src/main/port-identity.ts](../../multi_i2c_bridge/monitor_app/src/main/port-identity.ts) | `src/main/adapters/multi-i2c-bridge-adapter.ts` 内 or 共通化 | bridgeの `identity` 判別ロジック。motor用の `IdentityProbe` 実装と並列に配置 |

- 過度な共通化は行わない（[REQUIREMENTS.md §6](../REQUIREMENTS.md)の方針）。パーサ・コマンド組み立てロジックは種別ごとに独立ファイルとして維持し、共通化するのは `DeviceAdapter` インタフェースと `device-manager.ts` のライフサイクル管理のみとする。

---

## 8. 実装ロードマップ（[REQUIREMENTS.md §9](../REQUIREMENTS.md)に対応する技術タスク、外部依存を踏まえた順序）

| Phase | 技術タスク | 前提 |
|-------|-----------|------|
| 1 | `package.json`/`tsconfig.json` 雛形、`DeviceAdapter` インタフェース定義、`multi-i2c-bridge-adapter.ts` 移植・単体接続確認 | なし |
| 2 | `axis-mapping.ts`（electron-store連携、動的軸数対応）、軸マッピング設定UI、複数multi_i2c_bridge同時接続確認 | なし |
| 3 | bridge保守コマンドGUI化（F-RAM-GEAR-04） | Phase2完了 |
| 4 | bridgeパラメータ設定画面、CSVログ記録（bridge分） | なし |
| 5 | bridge単独運用版としてのパッケージ化（区切りが必要な場合） | Phase1〜4完了 |
| 6 | `stepping-motor-ble-adapter.ts` 実装・単体接続確認 | §8(REQUIREMENTS) #8: ファームウェアBLE GATT仕様確定後 |
| 7 | `control-app-client.ts` 実装、F-RAM-CTRL操作パネル（中継方式） | §8(REQUIREMENTS) #9: 制御アプリ・IPCプロトコル確定後 |
| 8 | `device-manager.ts` の `RobotArmSnapshot` 合成ロジック（動的軸数）、統合ダッシュボードUI、ギア角度中継突合表示（F-RAM-GEAR-01〜03）、ESTOP集約 | Phase6・7完了 |
| 9 | `trend-charts.ts` 拡張（軸詳細5チャートグループ＋軸横断比較ビュー、F-RAM-GRAPH-01/02）、複数基板同時接続の負荷確認 | Phase8完了 |
| 10 | 最終パッケージ化 | Phase1〜9完了 |

---

## 9. 通信アーキテクチャ方針：本アプリの実装への影響（サブシステム横断の決定事項は[design/SYSTEM_REQUIREMENTS.md §4](../../design/SYSTEM_REQUIREMENTS.md)を正とする）

トランスポート分離の決定事項・ブローカー撤回の経緯・WiFi方針・残存安全リスクは [design/SYSTEM_REQUIREMENTS.md §4/§6](../../design/SYSTEM_REQUIREMENTS.md) を正とする（システム横断の決定であり、robot_arm_monitor固有ではないため。[REQUIREMENTS.md §7](../REQUIREMENTS.md)も同様に要約のみを記載する構成に変更済み）。本章では**本アプリの通信層設計への影響のみ**を記載する。

### 9.1 本アプリの通信層への影響

[§3](#3-デバイスアダプタ層) で定義した `DeviceAdapter` インタフェースは、`connect`/`disconnect`/`sendCommand`/`update`イベントのみを上位（`device-manager.ts`・renderer）に公開し、内部実装（USB `SerialPort` かBLEクライアントか）を隠蔽する設計になっている。そのため：

- `BridgeAdapter`（§3.3、USB）と`StepBleAdapter`（§3.2、BLE）は同じ`DeviceAdapter`型として`device-manager.ts`から一様に扱える。
- `StepBleAdapter`は書き込み系コマンドを持たない読み取り専用アダプタとして実装する（`sendCommand`は実質未使用）。
- F-RAM-CTRLの書き込みコマンドは`DeviceAdapter`経路ではなく、別系統の`ControlAppClient`（§3.5）を通す。この分離により、将来SteppingMotorDriverのBLE接続が不安定化しても、モーション制御（制御アプリ・USB経由）には影響しない設計になっている。

### 9.2 スコープ外事項

以下は本書では規定しない（[design/SYSTEM_REQUIREMENTS.md §6](../../design/SYSTEM_REQUIREMENTS.md)の該当項目を参照）：

- SteppingMotorDriverファームウェアのBLE GATTサービス設計（#1）
- 制御アプリ本体・IPCプロトコルの詳細仕様（#2）
- Bluetoothデバイス検出・ペアリングのUX（#3）
- WiFi追加実装の用途・時期（#4）

これらが確定した時点で、本書§3.2/§3.5の該当セクションを更新する。

---

## 10. 未確定事項（実装前に要確認）

本アプリ固有の未確定事項は [REQUIREMENTS.md §8](../REQUIREMENTS.md) を参照（#1〜#7は確定済み）。システム横断の未解決事項（BLEテレメトリ・制御アプリIPC・Bluetoothペアリングux・WiFi・ESTOP残存リスク・軸マッピング上限）は [design/SYSTEM_REQUIREMENTS.md §6](../../design/SYSTEM_REQUIREMENTS.md) に集約されている（うち#1・#2はPhase6・7実装のブロッカー、#5は恒久的な残存安全リスクとして記録済み）。
