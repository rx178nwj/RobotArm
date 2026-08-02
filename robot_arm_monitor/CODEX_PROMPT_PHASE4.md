# Codex 実装プロンプト — robot_arm_monitor Phase 4

## 役割
あなたは Electron + TypeScript デスクトップアプリの実装を担当するエンジニアです。
RobotArm2 の複数基板を横断監視する統合モニタアプリ `robot_arm_monitor` の
**Phase 4**（bridgeパラメータ設定画面・CSVログ記録（bridge分））を、
本リポジトリ内の要件定義書・実装仕様書に厳密に従って実装してください。

Phase 1〜3（Electron雛形、複数`multi_i2c_bridge`接続、軸マッピング設定、bridge保守コマンドGUI）は
実装済みです。現在のコードベース（`src/main/`・`src/renderer/`・`src/shared/types.ts`）を
必ず読み込んでから着手し、既存の設計パターン（`DeviceAdapter`、IPC経由の正規化データ、
型付きIPCチャネル）を踏襲してください。

## 参照ドキュメント（正）
- `design/SYSTEM_REQUIREMENTS.md` — システム横断の要求仕様書（唯一の正）
- `robot_arm_monitor/REQUIREMENTS.md` §4.7（F-RAM-PARAM）・§4.8（F-RAM-LOG）— 本Phaseの要求仕様（唯一の正）
- `robot_arm_monitor/docs/design_spec.md` §8（実装ロードマップ Phase 4）・§4（共通データモデル）・§5（electron-store永続化）
- `multi_i2c_bridge/docs/usb_serial_spec.md` §4.4（`config`コマンド）・§4.3（`channels`）・§4.5（`master`）—
  bridgeのプロトコルの唯一の正。本アプリ側でコマンドを変更・拡張しない。
- `SteppingMotorDriver/monitor_app/REQUIREMENTS.md` §3.5（F-PARAM）・§3.6（F-LOG）— UI設計の参考実装
  （motor向けの記述であり、本Phaseはbridge分のみを対象とすることに注意）
- 既存実装：`robot_arm_monitor/src/main/adapters/multi-i2c-bridge-adapter.ts`・`device-manager.ts`・
  `src/renderer/renderer.ts`・`src/shared/types.ts`

作業前に上記ファイルを必ず読み込み、内容を実装に反映してください。矛盾する記憶や推測で補完しないこと。

## 重要な前提（誤読注意）
`multi_i2c_bridge`のUSBシリアルプロトコルには、パラメータを**変更**する`SET`系コマンドは
`ch <n> enable|disable`・`ch <n> dir <0|1>`（いずれもPhase 3で保守コマンドとして実装済み）以外に
**存在しません**（`usb_serial_spec.md` §4/§5全体を確認して裏取りすること）。
`config`コマンド（§4.4）は現在の実効設定（`angle_src`/`poll_period_ms`/`status_decim`/`as5600_conf`/
`ch_enable`/`dir_config`）を**読み取り専用**で返すのみです。
したがって本Phaseの「パラメータ設定画面」は、**bridgeごとの`config`出力を取得・表示し、
複数基板を横断比較できる読み取り専用ビュー**として実装してください
（F-RAM-PARAM-04「複数基板・複数軸のパラメータ一覧表示」のbridge分に相当）。
存在しない`SET CONFIG`系コマンドを勝手に発明しないこと。

## 今回のスコープ（Phase 4 のみ）
Phase 5以降（パッケージ化）、Phase 6以降（SteppingMotorDriver向けBLEアダプタ、制御アプリIPC、
統合ダッシュボード、ギア角度中継突合、トレンドグラフ）は着手しないこと。

Phase 4 の内容：
1. bridgeパラメータ表示画面（`config`コマンドの取得・表示、複数基板の横断比較テーブル）
2. CSVログ記録機能（bridge分：`channels`/`status`/`master`の定期スナップショットをCSVへ記録）

## Phase 4 実装要件（詳細）

### 4-A. bridgeパラメータ表示画面（F-RAM-PARAM bridge分）
- 接続中の各bridgeに対して`config`コマンドを送信し、応答をパースして表示する
  （`CONFIG angle_src=RAW poll_period_ms=0 status_decim=9 as5600_conf=0x0A00 ch_enable=0x3F dir_config=0x00 dir_applied=0x00`
  形式、`usb_serial_spec.md` §4.4）。
- `src/shared/types.ts`に`BridgeConfig`型（`angleSrc`/`pollPeriodMs`/`statusDecim`/`as5600Conf`/
  `chEnable`/`dirConfig`/`dirApplied`）を追加し、`BridgeSnapshot`に`config?: BridgeConfig`を追加する。
- 複数bridgeが接続されている場合、基板IDを行、パラメータ項目を列とした横断比較テーブルで表示する
  （既存の「接続中の基板」切替UIとは別に、常時比較できるビューとする）。
- チャンネルenable/DIR設定（`ch_enable`/`dir_config`のビットフィールド）は、Phase 3で実装済みの
  チャンネル別テーブル（`channels`コマンドの`ENABLE`/`DIR_CFG`列）と重複させず、`config`由来の
  集約ビット値としてのみ表示する（矛盾があれば両方表示してユーザーに気づかせてよい）。
- 手動での`config`再取得ボタンを設ける（自動ポーリングは本Phaseでは必須ではない、Phase 1の
  「単発取得でよい」方針を踏襲）。

### 4-B. CSVログ記録（F-RAM-LOG bridge分）
`SteppingMotorDriver/monitor_app/REQUIREMENTS.md` F-LOG-01〜03を土台に、bridge分として実装する：

- **F-LOG-01相当**：ユーザー操作（開始/停止ボタン）でロギングをON/OFFできる。
  ロギング中は一定周期（既定1000ms、`multi_i2c_bridge/monitor_app`の既定値を踏襲。
  `robot_arm_monitor/docs/design_spec.md` §5の`pollingMs.bridge`とは独立でよい）で
  接続中の**全**bridgeに対し`status`・`channels`・`master`を取得し、1行ずつCSVへ追記する。
  記録項目：ISO8601時刻、基板ID、チャンネル番号(0-5)、`PRESENT`/`ENABLE`/`OK`、`ANGLE`/`DEGREE`、
  `AGC`、`READ_OK`/`READ_ERR`、対応する`status`のFAULT/CH_FAULT、`master`の`last_activity_ms`。
- **F-LOG-02相当**：既存の送受信ログ（`RawLogEntry[]`、時刻付き）をCSVとしてエクスポートするボタンを設ける。
- **F-LOG-03相当**：ログファイル名にロギング開始時刻を含める（例: `bridge_log_YYYYMMDD_HHMMSS.csv`）。
- 出力先はユーザーがダイアログ（`dialog.showSaveDialog`）で選択できるようにする。デフォルトの
  ディレクトリはアプリの作業ディレクトリでよい（`electron-store`への保存先永続化は本Phaseでは必須ではない）。
- ロギング中の定期ポーリングが既存の単発`status`/`channels`取得や保守コマンド送信と衝突しない
  よう、`multi-i2c-bridge-adapter.ts`の`DeviceSession`（`startMonitor`/`stopMonitor`相当）を
  流用・拡張すること。新規に並行ポーリングループを増やして通信を輻輳させないこと。

### アーキテクチャ制約
- CSV書き込み・ファイルダイアログはメインプロセス側（`main.ts`または新規`src/main/csv-logger.ts`）で行う。
  レンダラーからはIPC経由でロギング開始/停止・エクスポートを指示するのみとする
  （既存の「シリアルI/Oはメインプロセスに集約」方針、design_spec.md §1を踏襲）。
- `config`パース処理は`parser.ts`または新規パーサ関数として追加し、既存の行パーサ構成を崩さないこと。

### 非機能要件（Phase 4 範囲）
- CSV書き込み失敗（ディスク容量・権限等）でアプリ全体がクラッシュしないこと。エラーはUI上に表示する。
- ロギング中にbridgeが切断された場合、当該基板の記録を停止しエラー表示するが、他の接続中bridgeの
  ロギングは継続する。

## 成果物
- `src/shared/types.ts`（`BridgeConfig`型追加）
- `src/main/adapters/multi-i2c-bridge-adapter.ts` または `parser.ts`（`config`応答パース追加）
- `src/main/csv-logger.ts`（新規、CSV書き込み・ファイルダイアログ処理）
- `src/main/main.ts`（IPCハンドラ追加：`config`取得、ロギング開始/停止、送受信ログエクスポート）
- `src/main/preload.ts`（新規IPC APIの公開）
- `src/renderer/renderer.ts`（パラメータ比較テーブルUI、ロギング操作UI追加）
- `README.md`追記（パラメータ画面・ログ記録の使い方）

## 完了条件（Definition of Done）
- 接続中の複数bridgeに対し`config`を取得し、横断比較テーブルに表示できる
- ロギング開始でCSVファイルが作成され、`status`/`channels`/`master`のスナップショットが定期的に
  追記される（実機が無い場合はコード上の到達可能性を確認し、その旨を報告する）
- ロギング停止・送受信ログのCSVエクスポートが動作する
- Phase 5以降の機能（パッケージ化、SteppingMotorDriver対応、統合ダッシュボード等）は実装しない
- 実装後、変更ファイル一覧と動作確認方法（または未確認事項）を簡潔に報告すること
