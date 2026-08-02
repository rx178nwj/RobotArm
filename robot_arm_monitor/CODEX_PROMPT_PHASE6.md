# Codex 実装プロンプト — robot_arm_monitor Phase 6

## 役割
あなたは Electron + TypeScript デスクトップアプリの実装を担当するエンジニアです。
RobotArm2 の統合モニタアプリ `robot_arm_monitor` の **Phase 6**
（SteppingMotorDriver向けBLEアダプタ実装・単体接続確認）を、本リポジトリ内の要件定義書・
実装仕様書に厳密に従って実装してください。

**前提条件：**
- robot_arm_monitor Phase 1〜5（multi_i2c_bridge系統一式）が完了していること。
- SteppingMotorDriverファームウェア側のBLEテレメトリ機能（`SteppingMotorDriver/firmware/
  CODEX_PROMPT_BLE_PHASE1.md`・`PHASE2.md`）が実装済みで、実機でGATTサービスが確認できる状態
  であることが望ましい。実機ファームウェアが未実装/未接続でも、要件仕様（下記参照）に基づき
  アダプタの実装自体は進められるが、その場合は**実機接続確認ができない旨を完了条件で明記**すること。

未完了の場合は着手せず、その旨を報告してください。

## 参照ドキュメント（正）
- `design/SYSTEM_REQUIREMENTS.md` §4（通信アーキテクチャ方針：モニタアプリ⇔SteppingMotorDriverは
  Bluetooth読み取り専用）
- `SteppingMotorDriver/firmware/BLE_WIFI_REQUIREMENTS.md` §4（BLE要件）— **本Phaseが接続する
  GATTサービス・ペアリング方式のプロトコルの唯一の正**。本アプリ側でキャラクタリスティック構成・
  UUID割当・ペアリング方式を変更・拡張しない。
- `robot_arm_monitor/REQUIREMENTS.md` §4.1 F-RAM-CONN-01/02（種別混在デバイス検出・識別）
- `robot_arm_monitor/docs/design_spec.md` §3.1（`DeviceAdapter`共通インタフェース）・
  §3.2（`StepBleAdapter`）・§4（`AxisSnapshot`のmotorフィールド、共通データモデル）
- 既存実装：`src/main/adapters/device-adapter.ts`（`DeviceAdapter`インタフェース、`VID_HINT`）・
  `src/main/adapters/multi-i2c-bridge-adapter.ts`（USBアダプタの実装パターン、`DeviceAdapter`への
  適合のさせ方の参考）・`src/shared/types.ts`

作業前に上記ファイルを必ず読み込み、内容を実装に反映してください。矛盾する記憶や推測で補完しないこと。

## 絶対に守ること（安全制約）
- **本アダプタは読み取り専用**。`sendCommand`/`executeCommand`は呼び出さない（`DeviceAdapter`
  インタフェース上は存在するが、`StepBleAdapter`から呼ばれた場合はエラーを投げる実装とする、
  `design_spec.md` §3.2）。BLE経由でSteppingMotorDriverへの書き込みコマンド（ENABLE/MOVE/JOG/
  ESTOP等）を発行するコードを一切書かないこと（モーション制御は将来Phase 7の`ControlAppClient`
  経由のみ、本Phaseの対象外）。
- ファームウェア側は書き込み可能なキャラクタリスティックを持たない設計のため（`BLE_WIFI_
  REQUIREMENTS.md` §4.1）、本Phaseで書き込みを試みても失敗する設計になっている。二重の安全網として
  アプリ側でも書き込みコードを持たないこと。

## 未確定事項：Node.js BLE Central ライブラリの選定（本Phaseで決定すること）
`docs/design_spec.md` §1では「BLEクライアントライブラリ選定は§8未解決事項」とされたまま未決定です。
対象OSはWindows 10/11のみ（`REQUIREMENTS.md` §5）。着手前に以下を調査し、選定理由を成果物に含めること：

- Node.js/ElectronメインプロセスからWindows上でBLE Centralとして動作できるライブラリを比較する
  （候補例：`@abandonware/noble`系、Windows WinRT Bluetooth LE APIをラップする実装、他）。
  `noble`本家は事実上メンテ終了・Windows対応に制約があることが知られているため、Windows実機での
  動作実績・メンテナンス状況を確認してから選定すること。
- 選定したライブラリがLE Secure Connections + Just Worksペアリング（`BLE_WIFI_REQUIREMENTS.md`
  §4.4）・GATT Notify購読・Service UUIDスキャンフィルタに対応していることを確認する。
- 対応できない場合は、Windows標準のペアリングUI（OS側のBluetoothデバイス追加）に一部委ねる設計
  （アプリはペアリング済みデバイスへの接続のみ行う）も選択肢として検討してよいが、その場合は
  `REQUIREMENTS.md F-RAM-CONN-01`の「候補ポート選択→接続」に相当するUXをどう実現するか設計し、
  報告に明記すること。

## 今回のスコープ（Phase 6 のみ）
Phase 7（制御アプリIPC中継、`F-RAM-CTRL`）、Phase 8（統合ダッシュボード、ギア角度中継突合、ESTOP集約）、
Phase 9（トレンドグラフ）、Phase 10（最終パッケージ化）は着手しないこと。

Phase 6 の内容：
1. Node.js BLE Centralライブラリの選定（上記）
2. `stepping-motor-ble-adapter.ts`の実装（`DeviceAdapter`インタフェースへの適合）
3. BLEスキャン・Service UUIDによる候補デバイス一次分類、Device Info読み取りによる識別確定
4. ペアリング・単一デバイス接続確認、Axis Status/Power/Fault InfoのNotify受信

## Phase 6 実装要件（詳細）

### `stepping-motor-ble-adapter.ts`（`design_spec.md` §3.2）
- `DeviceAdapter`インタフェース（`src/main/adapters/device-adapter.ts`）に適合させる。
  `connect(path, periodMs)`の`path`はBLEデバイスの識別子（MACアドレスまたはOSが割り当てるBLE
  デバイスID、選定ライブラリの流儀に従う）を受け取る形にする。
- GATTサービス（`BLE_WIFI_REQUIREMENTS.md` §4.1）の4キャラクタリスティック（Device Info/Axis
  Status/Power-ADC/Fault Info）を購読し、受信したJSONを`DeviceSnapshot`（`src/shared/types.ts`）
  に正規化して`update`イベントでemitする。`multi-i2c-bridge-adapter.ts`の`emitUpdate`パターンを参考
  にする。
- 識別：Device Infoキャラクタリスティック読み取りで`product=stepping_motor_driver`を検証してから
  接続を確定する（`BLE_WIFI_REQUIREMENTS.md` §4.2、USB `identity`コマンド検証方式と同じパターン）。

### スキャン・候補デバイス一覧（F-RAM-CONN-01のBLE版）
- BLEスキャンを行い、Advertised Service UUID（ファームウェアPhase 1で発番されたテレメトリサービス
  UUID。`BLE_WIFI_REQUIREMENTS.md` §4.1/§9.1で「実装時に正式発番」とされているため、firmware側の
  実装済みコードまたはドキュメント更新箇所からUUID値を確認して転記すること。推測値を使わない）で
  一次分類する。
- Device Name（`SMD-<board_id>`）から`board_id`を抽出し、候補一覧に表示する。
- 自動全接続はしない。ユーザーが候補から選択して「接続」操作を行う（`multi_i2c_bridge`と同じUX方針、
  `REQUIREMENTS.md F-RAM-CONN-01`）。

### ペアリング（`BLE_WIFI_REQUIREMENTS.md` §4.4）
- 選定したライブラリのペアリングAPI（またはWindows OS標準のペアリングUIへの委譲）を使い、Just Works
  ペアリング・暗号化リンク確立を行う。
- ボンディング済みデバイスは再ペアリングなしで再接続できることを確認する。

### デバイス管理・接続フロー（Phase 6 範囲）
- 単一デバイスの接続確認までを対象とし、複数SteppingMotorDriver同時接続・軸マッピング統合は
  Phase 8対象（`device-manager.ts`の`RobotArmSnapshot`合成ロジック）とする。既存の
  `multi-i2c-bridge-adapter.ts`と同様、`device-manager.ts`への登録は行うが、`RobotArmSnapshot`への
  統合はPhase 8まで行わない。
- 送受信ログ（Notify受信したJSON、時刻付き）を既存の送受信ログパネルと同じ形式でレンダラーに表示する
  （`RawLogEntry`、`src/shared/types.ts`）。

### アーキテクチャ制約
- BLE通信はメインプロセスに集約し、レンダラーへはIPC経由の正規化データのみを渡す（既存方針を踏襲）。
- `multi-i2c-bridge-adapter.ts`（USB）と`stepping-motor-ble-adapter.ts`（BLE）が同じ`DeviceAdapter`
  型として`device-manager.ts`から一様に扱えることを確認する（`design_spec.md` §9.1の設計意図）。

### 非機能要件（Phase 6 範囲）
- BLE接続断・スキャン失敗・ペアリング失敗でアプリ全体がクラッシュしないこと。エラーはUI上に表示する。
- BLE切断はモーション制御に一切影響しない（本Phaseの対象外だが、設計上の分離を壊さないこと）。

## 成果物
- `src/main/adapters/stepping-motor-ble-adapter.ts`（新規）
- 選定したBLEライブラリの`package.json`への追加
- `src/main/device-manager.ts`（BLEアダプタの登録・スキャン結果統合）
- `src/renderer/renderer.ts`（BLEデバイス候補一覧・接続操作・送受信ログUI追加）
- `README.md`追記（BLE接続の使い方、選定ライブラリとWindows動作要件）

## 完了条件（Definition of Done）
- BLEスキャンで`SMD-<board_id>`の候補デバイスが一覧表示される（実機が無い場合はコード上の到達可能性
  を確認し、その旨を報告する）
- ペアリング→接続→Device Info識別確認→Axis Status/Power/Fault InfoのNotify受信が実機で確認できる
  （実機確認できない場合は未確認事項として明記する）
- BLE経由での書き込みコマンドが一切実装されていないことをコードレビューで確認する
- Phase 7以降の機能（制御アプリIPC、統合ダッシュボード、ギア角度中継突合、トレンドグラフ）は実装しない
- 実装後、変更ファイル一覧・選定したBLEライブラリとその理由・動作確認方法（または未確認事項）を
  簡潔に報告すること
