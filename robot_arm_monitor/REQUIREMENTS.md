# ロボットアーム統合モニタ 要件定義書

RobotArm2 を構成する **SteppingMotorDriver 基板（複数枚、現行3枚・将来最大4枚）** と
**multi_i2c_bridge 基板（複数枚、現行3枚・将来最大4枚）** を、1つのデスクトップアプリから横断的に監視・操作するための要件定義書。

| 項目 | 内容 |
|------|------|
| 対象 | ロボットアーム統合モニタ（新規アプリ、`robot_arm_monitor/`） |
| 位置づけ | 既存の [SteppingMotorDriver/monitor_app](../SteppingMotorDriver/monitor_app/REQUIREMENTS.md)、[multi_i2c_bridge/monitor_app](../multi_i2c_bridge/docs/monitor_app_spec.md) を代替する統合アプリ（§6） |
| 版 | 0.1（初版） |
| 作成日 | 2026-07-25 |
| 実装状況 | Phase 1〜2実装済み（Electron雛形、bridge接続、複数bridge管理、軸マッピング永続化） |

---

## 1. 概要・目的

### 1.1 背景

RobotArm2 の各関節は以下の2系統のマイコン基板で制御・監視される。基板構成は現行 SteppingMotorDriver×3 + multi_i2c_bridge×3（9軸相当）で、将来最大4+4（12軸相当）まで拡張予定（[design/IF_design.drawio](../design/IF_design.drawio)、§3.1）。論理軸の呼称（J1、J2…）はユーザー設定によるラベルであり、軸数・基板数を固定enumとしては扱わない。

1. **SteppingMotorDriver（ESP32-S3、3軸/枚）**：モーター駆動・エンコーダ・電流監視・ホーミング等の主制御。現行3枚を同時接続して運用する（[SteppingMotorDriver/monitor_app/REQUIREMENTS.md §1.1](../SteppingMotorDriver/monitor_app/REQUIREMENTS.md)は2枚運用を前提に書かれた既存アプリの記述であり、本アプリでは3枚以上に対応する）。
2. **multi_i2c_bridge（RP2040、AS5600×6ch/枚）**：各軸ギアボックスのアウトプット軸絶対角度を集約。SteppingMotorDriver と I2C 直結し、`GET GEAR_ANGLE` 等の形でモーター基板側USBから角度が中継される（[GEAR_ANGLE_MONITOR_REQUIREMENTS.md](../SteppingMotorDriver/firmware/GEAR_ANGLE_MONITOR_REQUIREMENTS.md)）と同時に、bridge自体もUSB-CDCの独立した診断チャネルを持つ（[usb_serial_spec.md](../multi_i2c_bridge/docs/usb_serial_spec.md)）。

現状、この2系統にはそれぞれ独立したElectronモニタアプリ（[SteppingMotorDriver/monitor_app](../SteppingMotorDriver/monitor_app/)、[multi_i2c_bridge/monitor_app](../multi_i2c_bridge/monitor_app/)）が存在するが、ロボットアーム1台の状態を俯瞰するには2つのアプリを並行して起動・見比べる必要があり非効率である。

### 1.2 目的

1. **ロボットアーム単位の統合監視**：全論理軸の状態（モーター側テレメトリ + ギア出力角度）を1画面で俯瞰する。
2. **複数基板・複数種別デバイスの同時接続管理**：SteppingMotorDriver（現行3枚・将来最大4枚）と multi_i2c_bridge（現行3枚・将来最大4枚）を種別混在で同時接続し、それぞれの基板固有ID（factory MAC / 永続基板ID）で識別する。
3. **bridgeの二重の可視性**：SteppingMotorDriver 経由で中継されるギア角度（`GET GEAR_ANGLE`/`GET GEAR_STATUS`）と、bridge へ直接USB接続して取得する生の診断情報（`channels`/`status`/`master`/`log`）の**両方**を同一画面上で対比できるようにする。両者の乖離は配線・I2C通信・ソフトウェア不整合の切り分けに使う。
4. **安全操作の集約**：接続中の全 SteppingMotorDriver 基板へ同時に ESTOP を発行する一括操作を提供する。

### 1.3 対象ユーザー

- 開発者本人（実機デバッグ・チューニング・ギア角度キャリブレーション）
- 複数軸・複数基板を横断した組立検証、脱調・ギア出力乖離の切り分け作業

### 1.4 非対象（本版スコープ外）

- ファームウェア・プロトコルの変更（本アプリはいずれの基板のコマンドセットも変更しない。プロトコルの正はそれぞれの仕様書、§2）
- クラウド同期・リモート監視（ローカルUSB接続のみ）
- multi_i2c_bridge 側の保守・強制制御コマンド（`rescan`/`ch read`/`ch write` 等）のフルGUI化は将来拡張とする（§4.6、[usb_serial_spec.md §5/§6](../multi_i2c_bridge/docs/usb_serial_spec.md)は参照専用パネルとしてv0.1では読み取り中心とする）

---

## 2. 対象デバイスとプロトコル（正となる仕様書）

本アプリはいずれのデバイスのプロトコルも再定義しない。各仕様書を単一の正（Single Source of Truth）とする。

| デバイス種別 | 通信 | プロトコルの正 | 既存モニタアプリ（参考実装） |
|-------------|------|----------------|------------------------------|
| SteppingMotorDriver（ESP32-S3、3軸/枚） | USB-CDC、テキスト行 + JSON応答（`STATUS`） | [SteppingMotorDriver/firmware/REQUIREMENTS.md §4](../SteppingMotorDriver/firmware/REQUIREMENTS.md) | [SteppingMotorDriver/monitor_app](../SteppingMotorDriver/monitor_app/)（`src/main/serial-session.js`） |
| SteppingMotorDriver ギア角度中継 | 同上（`GET GEAR_*`/`SET GEAR_*`/`EVT GEAR_*`） | [GEAR_ANGLE_MONITOR_REQUIREMENTS.md §4.6](../SteppingMotorDriver/firmware/GEAR_ANGLE_MONITOR_REQUIREMENTS.md) | 同上（実装中、Phase 6） |
| multi_i2c_bridge（RP2040、AS5600×6ch/枚） | USB-CDC、テキスト行 | [multi_i2c_bridge/docs/usb_serial_spec.md](../multi_i2c_bridge/docs/usb_serial_spec.md) | [multi_i2c_bridge/monitor_app](../multi_i2c_bridge/monitor_app/)（`src/main/device-session.ts`） |
| multi_i2c_bridge 上流レジスタ（参考） | I2C（SteppingMotorDriver⇔bridge、PCからは非対象） | [multi_i2c_bridge/docs/command_spec.md](../multi_i2c_bridge/docs/command_spec.md) | — |

> どちらのプロトコルも将来変更され得るため、本アプリの通信層は種別ごとに分離した「デバイスアダプタ」として実装し、片方の仕様変更が他方へ波及しない設計とする（実装方針は [docs/design_spec.md](docs/design_spec.md) §3）。

---

## 3. システム構成・デバイストポロジー

本章のシステム全体トポロジー・通信アーキテクチャは [design/SYSTEM_REQUIREMENTS.md](../design/SYSTEM_REQUIREMENTS.md)（システム横断のマスター要求仕様書、[IF_design.drawio](../design/IF_design.drawio)を正とする）を正とし、本書では**robot_arm_monitor固有の実装要件のみ**を記載する。

### 3.1 前提（[design/SYSTEM_REQUIREMENTS.md §3/§4](../design/SYSTEM_REQUIREMENTS.md)より要約）

- 現行の基板構成：SteppingMotorDriver×3 + multi_i2c_bridge×3（9軸相当）。将来最大4+4（12軸相当）まで拡張予定。
- bridge:SteppingMotorDriverは1:1ペアリング（I2C、GPIO38/39）。
- トランスポート：モニタアプリ⇔multi_i2c_bridgeはUSB（直接診断）、モニタアプリ⇔SteppingMotorDriverはBluetooth（読み取り専用）、制御アプリ⇔SteppingMotorDriverはUSB（専有、本アプリのスコープ外）。
- 詳細・決定根拠は [design/SYSTEM_REQUIREMENTS.md](../design/SYSTEM_REQUIREMENTS.md) を参照。

### 3.2 グローバル軸マッピング（新規要件、動的軸数対応）

基板台数が3+3（現行）〜4+4（将来上限）の間で変動しうるため、論理軸を固定の「J1〜J6」ではなく、**接続された基板構成に応じて動的に決まる論理軸リスト（最大12軸）**として扱う。

| 論理軸 | SteppingMotorDriver 対応 | multi_i2c_bridge 対応（ギア角度） |
|--------|--------------------------|-----------------------------------|
| Axis 1〜N（N=接続基板数×3、最大12） | 基板固有ID（factory MAC） + ローカル軸番号（0-2） | 基板固有ID（永続基板ID） + ローカルch番号（0-2, 通常CH0-2使用） |

- ユーザーは初回接続時に「どの基板のどのローカル軸/chが、どの論理軸に対応するか」を1回設定し、以後はアプリ設定に永続化する（基板固有IDベース、ポート名に依存しない。[SteppingMotorDriver/monitor_app/REQUIREMENTS.md F-CONN-06](../SteppingMotorDriver/monitor_app/REQUIREMENTS.md)、[multi_i2c_bridge/docs/design_spec.md §5.4](../multi_i2c_bridge/docs/design_spec.md)の識別方式をそれぞれ踏襲）。
- 論理軸の表示名（例：「J1」「J2」等、実際のロボットアーム関節名との対応）はユーザーがラベルとして自由に設定できるものとし、アプリ内部では固定enumにしない。
- 未マッピングの軸・chは「未割当」として表示し、ダッシュボード上でグレーアウトする。
- UI・データモデル上の上限は12軸（4基板×3軸）として設計する（§8未解決事項、拡張時の上限見直しは別途検討）。

---

## 4. 機能要件

### 4.1 デバイス管理（F-RAM-CONN）

#### F-RAM-CONN-01: 種別混在デバイス検出・接続（判別方法確定）

- 起動時にシステム上のシリアルポート一覧を列挙し、`vendorId`（`serialport.list()`が返すUSB VID）でSteppingMotorDriver候補・multi_i2c_bridge候補に**一次分類**する：

  | VID（小文字16進） | ベンダー | 対応候補 | 根拠 |
  |------|------|------|------|
  | `303a` | Espressif | SteppingMotorDriver候補 | ESP32-S3内蔵USB Serial/JTAGの既定VID（`firmware/sdkconfig`の`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`構成で確認、カスタムディスクリプタ未設定のため既定値のまま） |
  | `2e8a` | Raspberry Pi Trading | multi_i2c_bridge候補 | arduino-picoコアの既定VID（[multi_i2c_bridge/monitor_app/src/main/main.ts](../multi_i2c_bridge/monitor_app/src/main/main.ts)で既に候補フィルタとして実装済み・実績あり） |
  | 上記以外 | — | 非候補（自動判別対象外） | 無関係なUSB-CDCデバイスの誤認識を防ぐ（[multi_i2c_bridge/docs/design_spec.md MON-CON-02](../multi_i2c_bridge/docs/design_spec.md)の方針） |

- **VID/PIDは一次分類（探索順序の最適化）のみに用い、確定判定には使わない**。両VIDとも各チップベンダーの汎用USB-CDCデバイス全般で使われ得るため、接続確立時は必ずプロトコルレベルの識別コマンドで検証する（SteppingMotorDriver候補: `PING`→`GET BOARD_ID`、multi_i2c_bridge候補: `identity`）。分類が外れていた場合（例：VIDが`303a`でも`GET BOARD_ID`が無応答）は、もう一方のプロトコルで再試行するフォールバックを実装する。
- 接続は個別にユーザー操作で行う（自動全接続はしない。既存2アプリの方針を踏襲：[SteppingMotorDriver/monitor_app/REQUIREMENTS.md F-CONN-01](../SteppingMotorDriver/monitor_app/REQUIREMENTS.md)、[multi_i2c_bridge/docs/design_spec.md MON-CON-01](../multi_i2c_bridge/docs/design_spec.md)）。
- 接続確立シーケンス・疎通確認コマンドは種別ごとに異なる（SteppingMotorDriver: `PING`→`STATUS`、multi_i2c_bridge: `identity`）。いずれも各プロトコルの正（§2）に従う。

#### F-RAM-CONN-02: 基板固有ID識別・再接続

- SteppingMotorDriver は factory MAC、multi_i2c_bridge は永続基板ID（EEPROM保存）を識別キーとする（ポート名・COM番号非依存）。
- USB切断後、候補ポートを定期走査し、識別IDが一致した場合のみ自動再接続する（両アプリの既存方針を継承。周期は multi_i2c_bridge 側1秒周期に合わせる）。

#### F-RAM-CONN-03: 送受信ログ

- 基板ごとに送受信生ログを時刻付きで表示できる（開閉可能パネル）。

### 4.2 軸マッピング設定（F-RAM-MAP、新規）

#### F-RAM-MAP-01: 論理軸割当UI

- 接続済み基板一覧から、論理軸（最大12軸）ごとに「SteppingMotorDriver基板+ローカル軸」「multi_i2c_bridge基板+ローカルch」を選択・保存できる設定画面を提供する（§3.2）。

#### F-RAM-MAP-02: 未割当表示

- 論理軸に対応が設定されていない場合、ダッシュボード上で「未割当」として明示する。

### 4.3 統合ダッシュボード（F-RAM-DASH、新規）

#### F-RAM-DASH-01: 論理軸横断サマリー

- 接続構成に応じた論理軸（最大12軸）を横に並べた一覧で、以下を1行で表示する：
  - 軸状態（IDLE/ACCEL/CRUISE/DECEL/HOMING/FAULT、[SteppingMotorDriver/monitor_app/REQUIREMENTS.md F-MON-02](../SteppingMotorDriver/monitor_app/REQUIREMENTS.md)）
  - ステップ位置・エンコーダ位置・偏差
  - ギア出力角度（`GET GEAR_ANGLE` 中継値、および bridge 直接値との差分、§4.5）
  - 電流・電源電圧
  - 3階層通信状態（PC⇔基板シリアル／基板⇔上位I2C／基板⇔センサI2C、[multi_i2c_bridge/docs/monitor_app_spec.md §5.2](../multi_i2c_bridge/docs/monitor_app_spec.md)の3階層モデルを SteppingMotorDriver 側にも適用）

#### F-RAM-DASH-02: 軸詳細画面

- 論理軸1つを選択すると、モーター側詳細（[SteppingMotorDriver/monitor_app/REQUIREMENTS.md F-MON-02〜04](../SteppingMotorDriver/monitor_app/REQUIREMENTS.md)相当）とギア角度詳細（§4.5）を1画面にまとめて表示する。

#### F-RAM-DASH-03: 基板単位ビュー

- 論理軸横断ビューに加え、基板単位（SteppingMotorDriver 1枚 = 3軸、multi_i2c_bridge 1枚 = 6ch）の生データビューも提供する（既存2アプリのUIをほぼ踏襲、デバッグ用）。

### 4.4 モーション制御パネル（F-RAM-CTRL、制御アプリへの中継方式・確定）

[design/IF_design.drawio](../design/IF_design.drawio) の確定により、SteppingMotorDriver へのモーション制御コマンド（書き込み系）を送信できるUSB接続は**別アプリである制御アプリが専有**する。モニタアプリ（本アプリ）はSteppingMotorDriverに対してBluetooth（読み取り専用テレメトリ、§7）しか持たないため、**モニタアプリ自身はSteppingMotorDriverへ直接コマンドを発行しない**。

#### F-RAM-CTRL-00: 中継方式（確定）

- モニタアプリはF-CTRL-01〜06相当の操作パネルUIを保持するが、実際のコマンド発行は行わず、**ローカルIPC経由で制御アプリへ実行を依頼**し、制御アプリが自身のUSB接続で実機へコマンドを送信、結果（`OK`/`ERR`）をモニタアプリへ返す。
- **制御アプリが未起動・未接続の場合、モニタアプリの操作パネルは全て無効化（グレーアウト）する**（F-RAM-SAFETY、通信切断時の操作UI無効化ルールを制御アプリとの接続にも適用）。
- **`ESTOP` も本中継経路を通る**（Bluetoothへの書き込み例外は設けない、確定事項）。すなわち制御アプリが応答不能な場合、モニタアプリからのESTOPも実行できない。この点は残存リスクとして§8未解決事項に記載する。

#### F-RAM-CTRL-01〜06: 操作内容（[SteppingMotorDriver/monitor_app/REQUIREMENTS.md F-CTRL-01〜06](../SteppingMotorDriver/monitor_app/REQUIREMENTS.md) を論理軸ベースで踏襲）

- ENABLE/DISABLE、STOP、STOP_FREE、CLEAR_FAULT、HOME を論理軸単位で発行
- ジョグ操作、相対MOVE・絶対MOVETO
- 同一基板内の多軸同期移動（SYNC_MOVE）
- **全停止（ESTOP）集約操作**：接続中の**全 SteppingMotorDriver 基板**へ同時に ESTOP を発行するボタンを常時表示（複数基板運用時の最優先安全機能。実行は制御アプリへの中継経由、F-RAM-CTRL-00）

### 4.5 ギア角度・bridge診断パネル（F-RAM-GEAR、新規）

#### F-RAM-GEAR-01: 中継角度表示

- 各論理軸について、SteppingMotorDriver 経由の `GET GEAR_ANGLE`/`GET GEAR_RAW`/`GET GEAR_STATUS`/`GET GEAR_DEVIATION`（[GEAR_ANGLE_MONITOR_REQUIREMENTS.md F-GEAR-06](../SteppingMotorDriver/firmware/GEAR_ANGLE_MONITOR_REQUIREMENTS.md)）を定期取得し表示する。
- `EVT GEAR_DEGRADED`/`EVT GEAR_RECOVERED`/`EVT GEAR_UNAVAILABLE`/`EVT GEAR_AVAILABLE`/`EVT GEAR_DEVIATION_WARN` を受信しイベントログに表示する。

#### F-RAM-GEAR-02: bridge直接診断表示

- 対応する multi_i2c_bridge が直接接続されている場合、`channels`/`status`/`master`（[usb_serial_spec.md §4.3-4.5](../multi_i2c_bridge/docs/usb_serial_spec.md)）を定期取得し、bridgeの生の健全性（ch別 PRESENT/ENABLE/OK、上流I2C=SteppingMotorDriverとの通信活性）を表示する。

#### F-RAM-GEAR-03: 中継値と直接値の突合表示（判定条件・確定）

- **突合判定は該当軸が静止中（軸状態が `IDLE`）の場合に限定する**。動作中（ACCEL/CRUISE/DECEL/HOMING）は、中継値・直接値それぞれの取得タイミングのズレ（スキュー）だけで角速度相当の差分が生じ実際の異常と区別できないため、突合判定自体を行わない（差分値そのものは参考表示してよいが、警告色は出さない）。
- 同一論理軸について、SteppingMotorDriver 中継角度（F-RAM-GEAR-01）と bridge 直接角度（F-RAM-GEAR-02の`channels`出力）を並べて表示し、静止中に差分が閾値（既定 1.0°、UI設定可）を超える場合に警告表示する。乖離要因（I2C通信遅延、スケーリング設定差、オフセット/方向補正の不一致等）の切り分けに使う。
- 突合前に、bridge直接値（センサ生角度）へも中継値と同じ補正（`gear_dir_sign`/`gear_angle_offset`、[GEAR_ANGLE_MONITOR_REQUIREMENTS.md F-GEAR-03](../SteppingMotorDriver/firmware/GEAR_ANGLE_MONITOR_REQUIREMENTS.md)）を適用してから比較する（未補正同士の比較は固定バイアスが乗るため行わない）。
- 対応する bridge が未接続の場合は中継値のみの表示にフォールバックする（bridge直接接続は診断用の補助であり必須ではない、§1.4）。

#### F-RAM-GEAR-05: bridge直接ポーリング周期（確定）

- bridgeへの直接USB接続のポーリング周期は **100ms**（[usb_serial_spec.md §4.7](../multi_i2c_bridge/docs/usb_serial_spec.md)の`monitor <100..60000|off>`が受理する下限値）とする。中継値側（SteppingMotorDriver、10ms周期でI2C取得・都度公開）より粗いが、F-RAM-GEAR-03で静止中限定判定とすることでスキューの影響を無視できるため、これ以上の高速化は不要と判断する。
- [multi_i2c_bridge/docs/monitor_app_spec.md §5.1](../multi_i2c_bridge/docs/monitor_app_spec.md)が示す既定1000msより短いが、プロトコル許容範囲内であり、bridge単体アプリの既定値とは独立して本アプリ側で100msに設定してよい。

#### F-RAM-GEAR-04: bridge保守コマンド（読み取り中心、v0.2／実装済み）

**方針改訂（2026-07-26）：** 当初はトレンドグラフ（F-RAM-GRAPH）実装完了・実機データ接続確認後に、コマンドごとに1つずつ実装・実機確認する方針だった。実際にはトレンドグラフ実装（Phase 9）に先行して、`rescan`/`fault clear`/`mux reset`/`ch enable|disable`/`ch dir`/`reboot`（[usb_serial_spec.md §5](../multi_i2c_bridge/docs/usb_serial_spec.md)）の6コマンド全てのGUIを一括実装した。段階導入によるリスク低減より実装効率を優先した判断であり、以後この方針を正とする。

- 全6コマンドをGUIから発行可能（`executeBridgeMaintenance`、[device-manager.ts](../src/main/device-manager.ts)）。
- 副作用が大きいコマンド（`ch dir`／`mux reset`／`reboot`）には実行前確認ダイアログを表示する（[renderer.ts](../src/renderer/renderer.ts) `maintenanceConfirmation`）。
- **実機での個別動作確認は未実施**（§9 ロードマップ Phase 3 参照）。各コマンドの実機確認が完了するまでは、保守コマンドGUIを実運用（本番のロボットアーム保守作業）で使用しないこと。

**2026-08-01 追加：0位置設定（`ch <0..5> zero set/clear`）**

multi_i2c_bridgeに追加された「0位置設定」機能（磁石取付誤差の補正、[command_spec.md §4.10](../multi_i2c_bridge/docs/command_spec.md)、[usb_serial_spec.md §5](../multi_i2c_bridge/docs/usb_serial_spec.md)）を、既存のch別保守操作（Enable/Disable/DIR）と同じチャンネルカードUIから発行できるようにする。

- `BridgeMaintenanceAction` に `channel_zero_set`／`channel_zero_clear` を追加し、`ch <n> zero set`／`ch <n> zero clear` を発行する（[shared/types.ts](../src/shared/types.ts)、[device-manager.ts](../src/main/device-manager.ts) `bridgeMaintenanceCommand`）。
- 各チャンネルカードに「0位置設定」（`caution`スタイル）・「0位置クリア」ボタンを追加（[renderer.ts](../src/renderer/renderer.ts) `renderMaintenance`）。
- 「0位置設定」は現在位置で既存の較正値を上書きする不可逆操作のため、`ch dir`と同様に実行前確認ダイアログを表示する（`maintenanceConfirmation`）。「0位置クリア」は既定値0へ戻すだけの操作のため確認ダイアログなしとする。
- 実行結果（`OK zero_offset=<値>`／`ERR ...`）はコマンド応答としてそのまま保守メッセージ欄に表示する（新規の状態表示・数値パースは行わない、v0.2スコープ外）。
- **実機での動作確認は未実施**。他6コマンドと同様、実機確認完了までは本番運用で使用しないこと。

**2026-08-02 追加：0位置設定後の角度の参照機能**

multi_i2c_bridgeに追加された確認用コマンド `ch <0..5> angle`（[usb_serial_spec.md §4.8](../multi_i2c_bridge/docs/usb_serial_spec.md)）を用いて、「0位置設定」「0位置クリア」の実行結果（較正後の角度が期待どおりか）をチャンネルカード上でその場で参照できるようにする。

- チャンネルカード（F-RAM-GEAR-04、CH別カード）に、当該chの現在角度（0位置オフセット適用後, `raw`/`deg`）を表示する参照欄を追加する。表示元は既存の周期ポーリング値（`channels`, 100ms周期, ChannelData.angle/degrees）を用い、追加のポーリングは発生させない。
- 「0位置設定」「0位置クリア」ボタン実行直後は、次回の周期ポーリング（最大100ms後）を待たず、`ch <n> angle`（[usb_serial_spec.md §4.8](../multi_i2c_bridge/docs/usb_serial_spec.md)）をオンデマンドで1回発行し、参照欄を即時更新する（`BridgeMaintenanceAction`に`channel_angle_query`相当を追加し、既存の`executeBridgeMaintenance`経路を再利用する想定）。
- 本参照機能は読み取り専用（bridgeの状態を変更しない）。実行前確認ダイアログは不要。
- 表示上は較正直後の`raw`が0付近（センサノイズ・巡回タイミング分の誤差のみ）であることを目視確認できることを主目的とする。厳密な数値検証（許容誤差判定・自動アラート）は本版のスコープ外とする。
- multi_i2c_bridge側の`ch angle`コマンド自体がファームウェア未実装（[usb_serial_spec.md §9](../multi_i2c_bridge/docs/usb_serial_spec.md)）のため、本機能もそれに依存する形で未着手とする。

### 4.6 トレンドグラフ（F-RAM-GRAPH、表示レイアウト確定）

[SteppingMotorDriver/monitor_app/REQUIREMENTS.md F-GRAPH-01〜03](../SteppingMotorDriver/monitor_app/REQUIREMENTS.md) を土台に、最大12軸への規模拡大を踏まえて**チャートあたりの系列数を絞る**方針で表示レイアウトを設計する（1チャートに過大な重畳は行わない）。

#### F-RAM-GRAPH-01: 軸詳細画面のチャートグループ（1軸につき最大4系列/チャート）

軸詳細画面（F-RAM-DASH-02）には、既存 SteppingMotorDriver アプリと同一のチャートグループ構成を踏襲し、ギア角度グループを1つ追加する：

| チャートグループ | 系列 |
|-----------------|------|
| 速度 | 対象軸の速度（steps/sec） |
| 位置/エンコーダ | ステップ位置・エンコーダ位置 |
| 偏差 | ステップ/エンコーダ偏差（脱調傾向） |
| 電流/電圧 | 電流値・電源電圧 |
| **ギア角度（新規）** | 中継角度（`GET GEAR_ANGLE`）・bridge直接角度・両者差分（F-RAM-GEAR-03、静止中のみ閾値超過をハイライト） |

- 1軸あたり最大5チャートグループ×最大4系列/グループで、既存アプリ（1軸・4チャートグループ）と同程度の負荷に収まる。

#### F-RAM-GRAPH-02: 軸横断比較ビュー（新規、最大12系列/チャート）

- ダッシュボード（F-RAM-DASH-01）とは別に、「メトリックを1つ選択し、接続中の論理軸の当該メトリックを1チャートに重畳表示する」軸横断比較ビューを提供する（例：全軸の電流値を1グラフで比較し、突出した軸を見つける）。
- 対象メトリックは速度・偏差・電流・電圧・ギア角度差分から選択できる。1チャートの系列数は論理軸数（最大12）を超えない。

#### F-RAM-GRAPH-03: ダッシュボード（F-RAM-DASH-01）はグラフを持たない

- メイン画面の論理軸横断サマリーテーブルは数値・状態色分けのみとし、常時描画のライブチャートは持たない（初期表示負荷を抑える）。トレンド確認は軸詳細画面（F-RAM-GRAPH-01）または軸横断比較ビュー（F-RAM-GRAPH-02）に限定する。

#### F-RAM-GRAPH-04: 共通操作

- 表示時間幅切替（10s/30s/60s/300s）、一時停止・カーソル確認、しきい値ライン表示は全チャート共通で提供する（[SteppingMotorDriver/monitor_app/REQUIREMENTS.md F-GRAPH-02/03](../SteppingMotorDriver/monitor_app/REQUIREMENTS.md)を踏襲）。
- 描画ライブラリは uPlot を継続採用する（既存アプリでの実績を、上記の系列数上限設計によりそのまま転用できるため、追加の負荷検証なしで採用可、§8未解決事項#4解決）。

### 4.7 パラメータ設定（F-RAM-PARAM）

[SteppingMotorDriver/monitor_app/REQUIREMENTS.md F-PARAM-01〜04](../SteppingMotorDriver/monitor_app/REQUIREMENTS.md) を踏襲し、以下を追加する：

- ギア角度関連パラメータ（`SET GEAR_OFFSET`/`SET GEAR_DIR`/`SET GEAR_ABS_CAPABLE`/`SET GEAR_DEVIATION_WARN`、[GEAR_ANGLE_MONITOR_REQUIREMENTS.md F-GEAR-06/08](../SteppingMotorDriver/firmware/GEAR_ANGLE_MONITOR_REQUIREMENTS.md)）の軸別編集
- 複数基板・複数軸のパラメータ一覧表示（既存 F-PARAM-04 を種別横断に拡張）

### 4.8 ログ記録・エクスポート（F-RAM-LOG）

[SteppingMotorDriver/monitor_app/REQUIREMENTS.md F-LOG-01〜03](../SteppingMotorDriver/monitor_app/REQUIREMENTS.md) を論理軸ベースに拡張し、CSV記録項目にギア角度（中継値・直接値・乖離量）を追加する。

### 4.9 安全機能（F-RAM-SAFETY）

- `ESTOP` 以外の破壊的操作（`RESET_CONFIG`、複数軸一括モーション、bridge `mux reset`/`reboot` 等）には確認ダイアログを設ける。
- 通信切断時は当該基板・当該論理軸の操作UIを無効化する。
- ギア角度モニタ（multi_i2c_bridge系統）の異常は、モーター制御・安全機構（ESTOP・過電流保護・通信ウォッチドッグ）に影響を与えない旨をUI上に明示する（[GEAR_ANGLE_MONITOR_REQUIREMENTS.md §4.7](../SteppingMotorDriver/firmware/GEAR_ANGLE_MONITOR_REQUIREMENTS.md)の設計方針をUI表現にも反映）。

### 4.10 関節検証パネル（F-RAM-VERIFY、新規、2026-08-08追加）

**目的：** 実機組立検証・キャリブレーション時に、同一関節が持つ3種のセンサ（POT・エンコーダ・ステップ位置）の
角度値を1画面で相互比較しながら、その場で回転指示を出して挙動を確認できるようにする（動作確認用パネル、
本番のモーション運用パネルであるF-RAM-CTRLとは目的・UIを分離する）。

#### F-RAM-VERIFY-01: パネル構成（論理軸ごとに1パネル）

論理軸（最大12軸、§3.2）ごとに1パネルを作成し、接続・マッピング済みの全論理軸を常時並べて表示する
（F-RAM-CTRLのような単一軸選択方式ではなく、関節間の相対関係を見比えられるよう複数パネル同時表示とする）。
未マッピングの論理軸は「未割当」としてグレーアウトする（F-RAM-MAP-02と同様）。

各パネルは以下の2ブロックで構成する：

**センサ値ブロック（読み取り専用）**

[firmware/REQUIREMENTS.md F-MOT-12](../SteppingMotorDriver/firmware/REQUIREMENTS.md)の
`GET POS_DEG`/`GET ENC_DEG`/`GET POT_DEG`コマンドを制御アプリがUSB-CDC経由でポーリングし、
ローカルIPC中継（[design/CONTROL_APP_REQUIREMENTS.md §4.5](../design/CONTROL_APP_REQUIREMENTS.md)）
で取得する4値を表示する（角度換算・ゼロ位置補正はいずれもファームウェア側で完結しており、本アプリ側では
一切の換算を行わず受信値をそのまま表示する）：

- POT角度（補正なし）：`pot_deg_raw`
- POT角度（ゼロ位置補正あり）：`pot_deg_zeroed`
- エンコーダ角度：`enc_deg`
- ドライバ角度（ステップ位置ベース）：`pos_deg`

**モータ制御ブロック（制御アプリへのIPC中継、F-RAM-CTRL-00の中継方式を踏襲）**

- プラス回転ボタン／マイナス回転ボタン：押下で`動作ステップ`欄の値に応じて相対回転を発行する
- 動作ステップ：以下2モードを切替可能とする
  - 角度モード：固定角度（既定1.0°、UI入力可）だけ`MOVE_DEG`（[design/CONTROL_APP_REQUIREMENTS.md §4.2](../design/CONTROL_APP_REQUIREMENTS.md)）をワンショット発行
  - 連続モード：ボタン押下中`VEL`を継続発行し離すと`STOP`（既存F-RAM-CTRL-01〜06のジョグ実装をそのまま再利用）
- 角度入力：絶対角度を入力し実行ボタンで`MOVETO_DEG`を発行する
- 0位置設定：現在のPOT値をゼロ位置補正として記録する（`POT_ZERO_SET`、[design/CONTROL_APP_REQUIREMENTS.md §4.2](../design/CONTROL_APP_REQUIREMENTS.md)）。現在位置の較正値を不可逆に上書きするため、
  multi_i2c_bridgeの「0位置設定」（F-RAM-GEAR-04）と同様に実行前確認ダイアログを表示する
- 0位置クリア：`POT_ZERO_CLEAR`を発行する（既定値へ戻すだけの操作のため確認ダイアログなし、F-RAM-GEAR-04の
  「0位置クリア」と同様の扱い）
- 上記いずれの操作も、実際のコマンド発行は制御アプリへのIPC中継経由で行う（F-RAM-CTRL-00）。
  **制御アプリ未接続時は本パネルのモータ制御ブロック全体をグレーアウトする**（センサ値ブロックも同じ
  IPC中継経由のため、制御アプリ未接続時はセンサ値も更新されず最終受信値の表示に留まる）。

#### F-RAM-VERIFY-02: 乖離の目視確認（判定なし）

3種の角度（POT ゼロ位置補正あり・エンコーダ・ドライバ）を並べて表示することで、組立誤差・センサ異常・
脱調等の切り分けをオペレータが目視で行えるようにする。F-RAM-GEAR-03のような自動しきい値判定・警告色は
本版では設けない（センサ系統・取り付け誤差が個体差として残ることが多く、閾値の妥当性を確立できていないため）。

#### F-RAM-VERIFY-03: 前提条件・依存

本パネルは以下の前提に依存する。いずれか未実装の間は「未対応」表示でフォールバックする：

- ファームウェア側 [F-MOT-12](../SteppingMotorDriver/firmware/REQUIREMENTS.md)（`GET POS_DEG`/`GET ENC_DEG`/`GET POT_DEG`/`MOVE_DEG`/`MOVETO_DEG`/`SET POT_ZERO`/`CLEAR POT_ZERO`）の実装
- 制御アプリのテレメトリポーリング・IPC中継実装（[design/CONTROL_APP_REQUIREMENTS.md §4.5](../design/CONTROL_APP_REQUIREMENTS.md)）
- 制御アプリIPCサーバーでの`MOVE_DEG`/`MOVETO_DEG`/`POT_ZERO_SET`/`POT_ZERO_CLEAR`中継実装（[design/CONTROL_APP_REQUIREMENTS.md §4.2](../design/CONTROL_APP_REQUIREMENTS.md)）

---

## 5. 非機能要件

| 項目 | 要件 |
|------|------|
| 対象OS | Windows 10/11（開発機環境。将来 Ubuntu/macOS 対応は範囲外、[multi_i2c_bridge/docs/monitor_app_spec.md §1](../multi_i2c_bridge/docs/monitor_app_spec.md)のUbuntu対応は本アプリでは踏襲しない） |
| パフォーマンス | SteppingMotorDriver最大3枚（100ms周期）＋ multi_i2c_bridge最大3枚（既定1000ms周期）の同時ポーリングを破綻なく処理できること |
| 堅牢性 | 種別を問わず、通信タイムアウト・パースエラーで当該デバイスのみエラー状態にし、アプリ全体はクラッシュさせない |
| 保守性 | デバイス種別ごとの通信層（アダプタ）を分離し、片方のプロトコル変更が他方に影響しない設計とする（[docs/design_spec.md](docs/design_spec.md) §3） |
| 設定永続化 | 基板識別ID↔論理軸/表示名マッピング、ポーリング周期、グラフ表示区間、ログ出力先をローカル設定ファイルに保存し次回起動時に復元する |

---

## 6. 既存アプリとの関係・移行方針

- [SteppingMotorDriver/monitor_app](../SteppingMotorDriver/monitor_app/) と [multi_i2c_bridge/monitor_app](../multi_i2c_bridge/monitor_app/) は、単一基板のみを接続して行う単体デバッグ・プロトコル検証用途として**引き続き維持**する（既存2アプリはいずれもUSB-CDC接続前提であり、本アプリのSteppingMotorDriver向け接続（Bluetooth、§7）とはトランスポートが異なる点に注意）。
- 本アプリの multi_i2c_bridge 向け通信アダプタは、既存ロジック（`multi_i2c_bridge/monitor_app/src/main/device-session.ts`・`parser.ts`・`port-identity.ts`）の実装を移植のベースとする。SteppingMotorDriver 向けは、[SteppingMotorDriver/monitor_app/src/main/serial-session.js](../SteppingMotorDriver/monitor_app/src/main/serial-session.js) からデータモデル（`STATUS`のJSON構造等）は参考にできるが、通信層（USB→Bluetooth）は新規実装が必要（詳細は [docs/design_spec.md](docs/design_spec.md) §7）。
- 将来的にロジック共通化（例: シリアルライン組み立て・タイムアウト管理の共通ユーティリティ化）を検討する余地はあるが、v0.1では**過度な共通化を行わず**、種別ごとに独立したアダプタとして実装する（プロトコルが今後も個別に変化するため、[GEAR_ANGLE_MONITOR_REQUIREMENTS.md](../SteppingMotorDriver/firmware/GEAR_ANGLE_MONITOR_REQUIREMENTS.md)のような追加要件は今後も両者で非同期に発生し得る）。

---

## 7. 通信アーキテクチャ方針：本アプリの実装への影響（サブシステム横断の決定事項は[design/SYSTEM_REQUIREMENTS.md §4](../design/SYSTEM_REQUIREMENTS.md)を正とする）

トランスポート分離の決定事項・ブローカー撤回の経緯・WiFi方針・残存安全リスクは [design/SYSTEM_REQUIREMENTS.md §4/§6](../design/SYSTEM_REQUIREMENTS.md) を正とする（システム横断の決定であり、robot_arm_monitor固有ではないため）。本章では**本アプリの実装への影響のみ**を記載する。

- [docs/design_spec.md §3](docs/design_spec.md) の `DeviceAdapter` インタフェースはトランスポートをアダプタ内部に隠蔽する設計のため、multi_i2c_bridge向けアダプタ（USB/`serialport`）は独立した`DeviceAdapter`実装として扱う。
- **2026-08-09、SteppingMotorDriverのテレメトリ取得経路をBluetooth直接接続からUSB-CDC（制御アプリ経由のローカルIPC中継）へ変更**（[design/SYSTEM_REQUIREMENTS.md §4](../design/SYSTEM_REQUIREMENTS.md)、[design/CONTROL_APP_REQUIREMENTS.md §4.5](../design/CONTROL_APP_REQUIREMENTS.md)）。SteppingMotorDriver向けの`DeviceAdapter`実装（BLE central、`stepping-motor-ble-adapter.ts`）は廃止し、代わりに`ControlAppClient`（`control-app-client.ts`）が制御アプリからの`telemetry`フレームを受信して`MotorSnapshot`を組み立てる。ファームウェア側のBLE/WiFiテレメトリ機能自体（[BLE_WIFI_REQUIREMENTS.md](../SteppingMotorDriver/firmware/BLE_WIFI_REQUIREMENTS.md)）は変更していない。
- モニタアプリのF-RAM-CTRL操作パネルは、実行を制御アプリへ中継するIPCクライアントとして実装する（§4.4 F-RAM-CTRL-00）。制御アプリ自体は本アプリのスコープ外・別プロジェクトとして実装される前提とする。
- 本アプリの実装対象外だが機能実現の前提条件となる外部依存（制御アプリ・IPCなど）は [design/SYSTEM_REQUIREMENTS.md §6](../design/SYSTEM_REQUIREMENTS.md) に集約し、本書§8ではrobot_arm_monitorへの影響としてのみ再掲する。

---

## 8. 未解決事項（実装前に要確認）

| # | 項目 | 優先度 |
|---|------|--------|
| ~~1~~ | ~~種別混在ポート列挙時の自動判別方法~~（解決済み：VID一次分類（`303a`=SteppingMotorDriver候補／`2e8a`=multi_i2c_bridge候補）＋プロトコル識別コマンドでの確定検証、§4.1 F-RAM-CONN-01） | ~~High~~ |
| ~~2~~ | ~~実機の bridge 台数~~（解決済み、後日更新：GPIO38/39単一マスタ制約によりSteppingMotorDriver 1枚:bridge 1台の1:1ペアリングは確定。台数自体は当初2+2としていたが、[design/IF_design.drawio](../design/IF_design.drawio)により**3+3（現行）・将来最大4+4**へ更新。各bridge CH0-2使用/CH3-5未使用は変わらず。§3.1） | ~~High~~ |
| ~~3~~ | ~~中継値とbridge直接値の突合の許容差分デフォルト値~~（解決済み：静止中（IDLE）限定で判定、閾値1.0°暫定値を維持。動作中は判定除外（スキュー影響回避）。§4.5 F-RAM-GEAR-03） | ~~Medium~~ |
| ~~4~~ | ~~グラフ描画ライブラリの選定~~（解決済み：uPlotを継続採用。1チャートあたりの系列数を絞る表示レイアウト（軸詳細=最大4系列/グループ、軸横断比較=最大6系列）を設計することで、既存アプリの実績をそのまま転用可能と判断。§4.6 F-RAM-GRAPH-01〜04） | ~~Medium~~ |
| ~~5~~ | ~~bridge保守コマンド（F-RAM-GEAR-04）のGUI化時期~~（解決済み・方針改訂2026-07-26：当初はトレンドグラフ実装完了後に1コマンドずつ導入する方針だったが、実際は先行して6コマンド全てを一括実装した。実機での個別動作確認が残課題。詳細は§4.5 F-RAM-GEAR-04参照） | ~~Low~~ |
| ~~6~~ | ~~electron-builder等によるパッケージ化要否~~（解決済み：本アプリの機能実装が完了した後にパッケージ化する。開発中は既存2アプリと同様`npm start`運用とし、パッケージ化を開発の並行タスクにしない） | ~~Low~~ |
| ~~7~~ | ~~USB通信ブリッジ（ブローカー）方式~~（解決済み：撤回。[design/IF_design.drawio](../design/IF_design.drawio)により、制御アプリ=USB専有、モニタアプリ=Bluetooth（読取専用）+USB(bridge直接)へトランスポート自体を分離する方式に変更。§7） | ~~-~~ |
| 8〜13 | システム横断の未解決事項（WiFi時期、ESTOP残存安全リスク、軸マッピング上限12軸の妥当性、制御アプリ自身の要求仕様書未作成）は [design/SYSTEM_REQUIREMENTS.md §6](../design/SYSTEM_REQUIREMENTS.md) に集約管理する（BLEテレメトリサービス・制御アプリIPC・Bluetoothペアリングuxは解消済み、2026-08-09以降テレメトリはUSB-CDC経由に変更） | 集約先を参照 |

---

## 9. 開発ロードマップ（案、外部依存を踏まえた順序に更新）

SteppingMotorDriver向け機能（テレメトリ・F-RAM-CTRL中継、いずれも制御アプリのローカルIPC経由）は外部依存（[design/SYSTEM_REQUIREMENTS.md §6](../design/SYSTEM_REQUIREMENTS.md) #1, #2）が解消するまで着手できなかったため、**依存のないmulti_i2c_bridge系統を先行**させる順序に変更した経緯がある（両依存とも解消済み）。

| Phase | 内容 | 状態 | 前提 |
|-------|------|------|------|
| 1 | プロジェクト雛形・`DeviceAdapter`インタフェース設計・単一multi_i2c_bridge接続（USB、[multi_i2c_bridge/monitor_app](../multi_i2c_bridge/monitor_app/)ロジック移植） | 実装済み | なし |
| 2 | 軸マッピング設定UI（F-RAM-MAP）・複数multi_i2c_bridge同時接続確認 | 実装済み（複数実機同時接続のみ実機2台目待ち） | なし |
| 3 | bridge保守コマンドGUI化（F-RAM-GEAR-04） | 実装済み（実機での保守コマンド個別確認待ち） | Phase2完了 |
| 4 | パラメータ設定（F-RAM-PARAM bridge分）・ログ記録（F-RAM-LOG bridge分） | 未着手 | なし |
| 5 | パッケージ化（electron-builder等、bridge単独運用版として一旦区切る場合） | 未着手 | Phase1〜4完了 |
| — | *（以下はSteppingMotorDriver向け機能。外部依存解消後に着手）* | | |
| 6 | SteppingMotorDriver向けテレメトリ受信実装・単一接続確認（2026-08-09以降：制御アプリIPC経由のUSB-CDCポーリング方式、旧BLEアダプタ方式から変更） | 実装済み | なし |
| 7 | 制御アプリIPC中継クライアント実装・F-RAM-CTRL | ブロック中 | §8 #9（制御アプリ・IPCプロトコル）確定待ち |
| 8 | 統合ダッシュボード（F-RAM-DASH）・ギア角度中継突合表示（F-RAM-GEAR-01〜03）・全停止集約（F-RAM-CTRL） | ブロック中 | Phase6・7完了 |
| 9 | トレンドグラフ統合（F-RAM-GRAPH-01〜04）・複数基板同時接続の総合確認 | ブロック中 | Phase8完了 |
| 11 | 関節検証パネル（F-RAM-VERIFY） | 実装済み | Joint Angle表示（2026-08-09以降は制御アプリIPC経由）・角度操作・POTゼロ設定・未対応フォールバックを実装、Phase 11スモークテスト追加 |
| 10 | 最終パッケージ化 | 未着手 | Phase1〜9・11完了 |
