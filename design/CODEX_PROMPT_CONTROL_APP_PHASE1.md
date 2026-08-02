# Codex 実装プロンプト — 制御アプリ（`control_app`）Phase 1: IPCサーバー・USB-CDC中継バックエンド

## 役割
あなたは Electron + TypeScript デスクトップアプリの実装を担当するエンジニアです。
RobotArm2 プロジェクトの新規アプリ **制御アプリ（`control_app`）** を、本リポジトリ内の
要求仕様書に厳密に従って実装してください。制御アプリは SteppingMotorDriver 基板への
USB-CDC 接続を専有し、モニタアプリ（`robot_arm_monitor`）からのモーション制御コマンドを
ローカルIPC経由で中継する常駐バックエンドです。

## 参照ドキュメント（正）
- `design/CONTROL_APP_REQUIREMENTS.md` — IPCプロトコル（トランスポート、フレーム形式、
  コマンドマッピング、ESTOP集約仕様、接続ライフサイクル）の**唯一の正**。作業前に全文を読むこと。
- `SteppingMotorDriver/firmware/REQUIREMENTS.md` §4（コマンドセット全体）— USB-CDCの
  テキストコマンド形式（§4.1）、モーション制御コマンド（§4.2）、非同期イベント（§4.5）、
  エラーコード表（§4.6）、基板固有ID（`GET BOARD_ID`・`iSerialNumber`、§F-COM-05）の唯一の正。
- `robot_arm_monitor/src/main/adapters/control-app-client.ts` — 本Phaseで実装するIPCサーバーと
  通信する**既存の**IPCクライアント実装。ワイヤプロトコル（フレームのキー名・型）は
  この実装が期待する形と完全互換であること（このファイル自体は変更しない）。
- `robot_arm_monitor/test/mock-control-app-server.js` — 上記クライアントが期待する応答の
  参考実装（簡易モック）。本Phaseで作るサーバーは、これと同じプロトコルをより忠実に、かつ
  実際のUSB-CDC中継を伴って実装する。
- `robot_arm_monitor/src/main/adapters/multi-i2c-bridge-adapter.ts`・`parser.ts` — USB-CDC
  シリアル通信の実装パターン（`serialport` + `EventEmitter`、コマンド送信とレスポンス待ち合わせ、
  タイムアウト処理）の参考。本Phaseの基板接続層も同様のスタイルで実装すること。
- `robot_arm_monitor/package.json`・`tsconfig.json`・ディレクトリ構成 — 新規 `control_app`
  プロジェクトの scaffold（Electron + TypeScript + `serialport` + `electron-builder`）の参考。

作業前に上記ファイルを必ず読み込み、内容を実装に反映してください。矛盾する記憶や推測で補完しないこと。

## 重要な前提：制御アプリ自身のGUI要求仕様書は未作成
`design/CONTROL_APP_REQUIREMENTS.md` §8 未解決事項#1のとおり、制御アプリのGUI構成
（ジョグ操作パネル、軸パラメータ編集画面、USB接続管理UX等）は別途要求仕様書が必要であり、
**本Phaseのスコープ外**です。本Phaseで作るウィンドウは、IPCサーバーの動作確認に必要な
最小限の状態表示（接続中のNamed Pipeクライアント有無、接続中のSteppingMotorDriver基板一覧、
簡易ログ）のみとし、ジョグ操作等の操作UIは実装しないこと。

## 今回のスコープ（Phase 1 のみ）
1. `control_app` プロジェクトの新規 scaffold（`robot_arm_monitor` と同水準のElectron+TypeScript構成）
2. 基板接続層：SteppingMotorDriverとのUSB-CDC通信（`serialport`、複数基板同時接続対応）
3. IPCサーバー層：Windows Named Pipe サーバー（`design/CONTROL_APP_REQUIREMENTS.md` §3〜§6）
4. 基板固有ID（`GET BOARD_ID`）＋ローカル軸番号によるコマンドの宛先解決
5. ESTOP集約（接続中の全基板へ並行発行、結果集約）
6. 最小限の状態表示ウィンドウ（操作UIなし）
7. モックを用いた動作確認テストハーネス（実機不要で検証できること）

## 実装要件（詳細）

### プロジェクト構成
- リポジトリルート直下 `control_app/`（`robot_arm_monitor` と同階層の兄弟プロジェクト）。
- `package.json`：`serialport`・`electron`・`electron-builder`・`typescript` を依存に追加。
  `robot_arm_monitor/package.json` の構成（`build`/`dev`/`start` スクリプト、`asarUnpack` に
  `serialport` ネイティブバインディング）を踏襲する。
- ディレクトリは `src/main/`（Electronメインプロセス、IPCサーバー・基板接続層）、
  `src/shared/`（型定義）、`src/renderer/`（最小限の状態表示ウィンドウ）、`test/` に分ける。

### 型定義（`src/shared/types.ts`）
`robot_arm_monitor/src/shared/types.ts` の `ControlCommand`/`CommandResult`/`EstopResult`/
`ControlEvent` 相当の型を、ワイヤプロトコルと矛盾しない形で定義する
（`design/CONTROL_APP_REQUIREMENTS.md` §3.2・§4.2のフレーム構造に一致させること）。

### 基板接続層（`src/main/board-connection.ts`）
- 1インスタンス＝1 SteppingMotorDriver基板とのUSB-CDC接続を管理する。
- `serialport`でシリアルポートを開き、`firmware/REQUIREMENTS.md` §4.1のテキストフォーマット
  （`<COMMAND> [ARG...]\n` → `OK [data]\n` / `ERR <code> <message>\n` / 非同期 `EVT <EVENT> [data]\n`）
  で送受信する。改行区切りパーサ（`multi-i2c-bridge-adapter.ts`のパターンを参考に、
  readlineパーサまたは自前バッファ処理のいずれでもよい）。
- コマンド送信はリクエスト/レスポンス方式（1コマンド=1応答、`OK`/`ERR`を待ち合わせる）。
  応答が来るまで次のコマンドを同一基板に送らないキュー処理とする（同一基板内の直列化）。
- タイムアウト5000ms（`design/CONTROL_APP_REQUIREMENTS.md` §4.4）で `TIMEOUT` エラーとする。
- `EVT`行は待ち合わせ対象と分離し、非同期イベントとして`EventEmitter`でemitする
  （`event`名・`axis`引数をパースし、`firmware/REQUIREMENTS.md` §4.5の一覧に対応させる）。
- 起動時（接続確立後）に `GET BOARD_ID` を送信して基板固有IDを取得し、以後のアドレス解決に使う
  （取得失敗時は`E012`をそのまま呼び出し元に伝える）。
- テストのためポートI/Oを注入可能にする（`serialport`の`SerialPort`インスタンスまたは
  それと同じ`Duplex`ストリームインタフェースを受け取れる設計とし、実機なしでモックストリームを
  使った単体テストができるようにすること）。

### 基板マネージャ（`src/main/board-manager.ts`）
- 複数基板の`board-connection`インスタンスを`boardId`（`GET BOARD_ID`の返却値）で管理する。
- `boardId + axis` からコマンドを対応する基板接続へルーティングする
  （`design/CONTROL_APP_REQUIREMENTS.md` §4.1のアドレス指定方式）。
- 対象`boardId`が未接続の場合は`{"ok":false,"error":"NOT_CONNECTED"}`相当を返す（§4.4）。
- ESTOP集約（§6）：接続中の全基板に対し`ESTOP`コマンドを**並行**送信し、基板ごとの
  `{boardId, ok, error?, message?}`を集約して返す。1基板が無応答でも他基板の発行をブロックしない。
- USB接続台数・状態の変化（基板の追加/切断）を`connection_changed`相当のイベントとして
  IPCサーバー層へ伝える（§5.2、型はIPCサーバー実装時に定義してよい）。
- ポート一覧取得・接続APIは内部関数として実装する（GUIは対象外だが、テストハーネスから
  呼べる形にする）。SteppingMotorDriverの固定VID/PIDは要求仕様書に記載がないため、
  `serialport.list()`の結果から候補を提示し、`GET BOARD_ID`で確認する方式とする。

### IPCサーバー層（`src/main/ipc-server.ts`）
- Windows Named Pipe（`\\.\pipe\robotarm-control-app`、`design/CONTROL_APP_REQUIREMENTS.md` §3.1）
  で`net.createServer({ path })`を使い待ち受ける。
- 同時接続数1（§3.1）：既に1クライアントが接続中なら2本目の接続要求は即座に`destroy()`で拒否する。
- フレーム形式は改行区切りJSON（§3.2）。受信した`{"id","type":"command","boardId","axis","command","args"}`
  を`board-manager`にルーティングし、結果を`{"id","type":"result","ok",...}`として返す。
- `{"type":"estop"}`受信時は`board-manager`のESTOP集約を呼び、
  `{"id","type":"estop_result","results":[...]}`として返す。
- `board-manager`からの`EVT`転送を`{"type":"event","boardId","event","axis"}`として、
  接続中のIPCクライアントへ非同期送信する（§4.3）。IDは付与しない（イベントはリクエストに対する
  応答ではないため）。
- モニタアプリが未接続でも制御アプリ自体（基板接続・IPCサーバー起動）は通常動作すること（§5.2）。

### Electronメインプロセス（`src/main/main.ts`）
- アプリ起動時に`board-manager`と`ipc-server`を初期化・開始する。
- 最小限のウィンドウ（`src/renderer/`）で以下のみ表示する：
  - IPCクライアントの接続状態（接続中/未接続）
  - 接続中のSteppingMotorDriver基板一覧（`boardId`、ポートパス、状態）
  - 直近のコマンド・イベントの簡易ログ
  - ジョグボタン等の操作UIは実装しない（次Phase以降、制御アプリ自身の要求仕様書策定後に追加）

### モックを用いた動作確認テストハーネス（`test/`）
実機なしで検証できるよう、以下2種のモックを用意する：
1. **モックIPCクライアント**（`test/mock-ipc-client.js`など）：`robot_arm_monitor`の
   `control-app-client.ts`と同じプロトコルでNamed Pipeに接続し、`ENABLE`/`MOVE`/`HOME`/
   エラー応答/`ESTOP`の一連のリクエストを送って応答を検証するスクリプト。
2. **モックSteppingMotorDriverストリーム**：`board-connection.ts`に注入する`Duplex`ストリームで、
   `firmware/REQUIREMENTS.md` §4.1のテキストプロトコルに従って`OK`/`ERR <code> <message>`/
   `EVT ...`を返す。これを使い、複数基板分の`board-manager`を実機なしで動作させ、
   IPCサーバー経由のend-to-endテスト（モックIPCクライアント → IPCサーバー → board-manager →
   モックSteppingMotorDriverストリーム）を実施する。

## 成果物
- `control_app/`（新規プロジェクト一式：`package.json`、`tsconfig.json`、`src/`、`test/`）
- `control_app/src/shared/types.ts`
- `control_app/src/main/board-connection.ts`
- `control_app/src/main/board-manager.ts`
- `control_app/src/main/ipc-server.ts`
- `control_app/src/main/main.ts`・`src/main/preload.ts`
- `control_app/src/renderer/`（最小限の状態表示ウィンドウ）
- `control_app/test/`（モックIPCクライアント・モックSteppingMotorDriverストリームによるテスト）
- `control_app/README.md`（起動方法、動作確認方法、GUI未実装範囲の明記）

## 完了条件（Definition of Done）
- モックIPCクライアントで、IPCサーバーへの接続・`ENABLE`/`MOVE`/`HOME`等のコマンド送信・
  応答受信ができることを確認する
- モックSteppingMotorDriverストリームからの`ERR <code> <message>`が、変換されずそのまま
  `{"ok":false,"error":"<code>","message":"<message>"}`としてIPC応答に透過されることを確認する
  （`design/CONTROL_APP_REQUIREMENTS.md` §4.4）
- 対象基板が未接続の場合に`NOT_CONNECTED`、無応答の場合に`TIMEOUT`が返ることを確認する
- 複数基板（モック2台以上）に対するESTOP集約で、基板ごとの成功/失敗が`estop_result`に
  正しく反映されることを確認する（1台無応答でも他方の結果が返ること）
- IPCサーバーへの2本目の接続要求が拒否されることを確認する
- `EVT`（例：`HOME_DONE`）がモックIPCクライアント側に`event`フレームとして届くことを確認する
- 制御アプリ自身のGUI操作パネル（ジョグ等）は実装しないこと、それが別途未解決事項である旨を
  `README.md`に明記すること
- 実際の`robot_arm_monitor`（`control-app-client.ts`）との結合テストは本Phaseでは必須としないが、
  実施した場合は結果を、未実施の場合はその旨を報告に明記すること
- 実装後、変更・新規ファイル一覧と動作確認方法（または未確認事項）を簡潔に報告すること
