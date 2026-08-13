# Codex 実装プロンプト — robot_arm_monitor 関節検証パネル（F-RAM-VERIFY）

## 役割
あなたは Electron + TypeScript デスクトップアプリの実装を担当するエンジニアです。
統合モニタアプリ `robot_arm_monitor` に、**関節検証パネル（F-RAM-VERIFY）**を、本リポジトリ内の
要件定義書に厳密に従って実装してください。

**前提条件：以下がすべて完了していること。未完了の場合は着手せず、その旨を報告してください。**
1. SteppingMotorDriver ファームウェア F-MOT-12（`GET POS_DEG`/`GET ENC_DEG`/`GET POT_DEG`/
   `MOVE_DEG`/`MOVETO_DEG`/`SET POT_ZERO`/`CLEAR POT_ZERO`、`firmware/CODEX_PROMPT_JOINT_ANGLE_PHASE1.md`）
2. ファームウェアのBLE Joint Angleキャラクタリスティック実装（`BLE_WIFI_REQUIREMENTS.md` §4.1）
3. 制御アプリIPCサーバーでの`MOVE_DEG`/`MOVETO_DEG`/`POT_ZERO_SET`/`POT_ZERO_CLEAR`中継実装
4. 本アプリのBLEアダプタ（`stepping-motor-ble-adapter.ts`）・制御アプリIPCクライアント
   （`control-app-client.ts`）・F-RAM-CTRL操作パネルが実装済みであること（既存実装）

## 参照ドキュメント（正）
- `robot_arm_monitor/REQUIREMENTS.md` §4.10 F-RAM-VERIFY-01〜03（本パネルの機能要件本体）
- `SteppingMotorDriver/firmware/REQUIREMENTS.md` §3.1 F-MOT-12（角度データの意味・POTゼロ位置補正の
  設計方針）・§4.2〜4.4（`MOVE_DEG`/`MOVETO_DEG`/`GET POS_DEG`/`GET ENC_DEG`/`GET POT_DEG`/
  `SET POT_ZERO`/`CLEAR POT_ZERO`のコマンド仕様）
- `SteppingMotorDriver/firmware/BLE_WIFI_REQUIREMENTS.md` §4.1 Joint Angle キャラクタリスティック
  （ペイロード形式：`[{"axis":0,"pos_deg":45.230,"enc_deg":45.180,"pot_deg_raw":45.560,"pot_deg_zeroed":0.120},...]`）
- `design/CONTROL_APP_REQUIREMENTS.md` §4.2（IPCコマンドマッピング表、`MOVE_DEG`/`MOVETO_DEG`/
  `POT_ZERO_SET`/`POT_ZERO_CLEAR`を追加済み）
- 既存実装（そのまま参考・再利用すること）：
  - `src/shared/types.ts`：`MotorGearStatus`/`GearRelayState`（Joint Angle用の型を追加する際の型定義パターン）、
    `AxisSnapshot`（`gearRelayed`/`gearDirect`ブロックの構造パターン）、`ControlCommand`（コマンド追加パターン）
  - `src/main/adapters/stepping-motor-ble-adapter.ts`：`parseGear`（新規`parseJointAngle`パーサの実装パターン）
  - `src/main/device-manager.ts`：`AxisSnapshot`組み立てロジック（gear関連ブロックの集約パターンをJoint Angleにも適用）
  - `src/main/adapters/control-app-client.ts`：`COMMANDS`Set（新規コマンド追加時に更新が必要）
  - `src/renderer/renderer.ts`：`renderControlPanel`・ジョグ実装（`jog-positive`/`jog-negative`の
    `onpointerdown`/`onpointerup`パターン）、`multi_i2c_bridge`の「0位置設定」確認ダイアログ実装
    （`maintenanceConfirmation`、不可逆操作の確認UIパターン）

作業前に上記ファイルを必ず読み込み、内容を実装に反映してください。矛盾する記憶や推測で補完しないこと。

## 重要な設計方針（要件書より）
- **角度換算・ゼロ位置補正は一切行わない**：`pos_deg`/`enc_deg`/`pot_deg_raw`/`pot_deg_zeroed`はすべて
  ファームウェアが計算済みの値をBLE経由でそのまま受信・表示する。本アプリ側でのステップ数・カウント数からの
  換算処理は実装しないこと（F-RAM-VERIFY-01）。
- **F-RAM-CTRLとは別パネル**：既存のControl Panel（単一軸選択、ジョグ/MOVE/MOVETO/SYNC_MOVE、steps単位）は
  一切変更しない。関節検証パネルは新規の別UIとして追加する。
- **表示は論理軸横断・常時複数パネル**：F-RAM-CTRLのような単一軸選択方式ではなく、マッピング済みの
  全論理軸のパネルを同時に並べて表示する（F-RAM-VERIFY-01）。
- **書き込みは制御アプリへのIPC中継のみ**：本アプリからSteppingMotorDriverへ直接コマンドを送らない
  （F-RAM-CTRL-00の中継方式を踏襲）。制御アプリ未接続時はモータ制御ブロックのみグレーアウトし、
  センサ値ブロック（BLE経由）は表示を継続する（F-RAM-VERIFY-01）。
- **突出判定・警告色は設けない**（F-RAM-VERIFY-02）。3値を並べて目視確認できれば十分。

## 今回のスコープ
1. 型定義拡張（`MotorJointAngle`等、Joint Angle BLEペイロードに対応する型）
2. BLEアダプタ：Joint Angleキャラクタリスティックのパース・スナップショットへの格納
3. `device-manager.ts`：`AxisSnapshot`へのJoint Angleブロック集約
4. `control-app-client.ts`／`shared/types.ts`：`MOVE_DEG`/`MOVETO_DEG`/`POT_ZERO_SET`/`POT_ZERO_CLEAR`
   を`ControlCommand`に追加
5. レンダラー：関節検証パネルUI（論理軸ごとに1パネル、センサ値ブロック＋モータ制御ブロック）

## 実装要件（詳細）

### 型定義（`src/shared/types.ts`）
- `MotorJointAngle`型を追加：`{ axis: number; posDeg: number | null; encDeg: number | null; potDegRaw: number | null; potDegZeroed: number | null }`
  （BLEペイロードのキー名`pos_deg`等からのマッピングはBLEアダプタ側で行う。フロント向け型は
  既存の`MotorAxisStatus`等と統一感のあるcamelCase）
- `MotorSnapshot`に`jointAngle: MotorJointAngle[]`を追加
- `AxisSnapshot`に`jointAngle?: { boardId: string; localAxis: number; posDeg: number | null; encDeg: number | null; potDegRaw: number | null; potDegZeroed: number | null }`を追加
- `ControlCommand`共用体に`"MOVE_DEG" | "MOVETO_DEG" | "POT_ZERO_SET" | "POT_ZERO_CLEAR"`を追加

### BLEアダプタ（`stepping-motor-ble-adapter.ts`）
- Joint Angleキャラクタリスティックの購読・パース（`parseGear`と同様のパターン）を追加し、
  `axes`プロパティと並ぶ`jointAngle: MotorJointAngle[]`フィールドに格納する
- キャラクタリスティック未実装の基板（ファームウェアが古い等）に対しては、パース失敗時に
  空配列にフォールバックし、アダプタ全体をエラーにしないこと（既存の`parseGear`のエラー耐性方針を踏襲）

### `device-manager.ts`
- `AxisSnapshot`組み立て時、対応する`boardId`+`localAxis`の`MotorJointAngle`エントリを検索し
  `jointAngle`ブロックへ格納する（`gearRelayed`ブロックの組み立てパターンを踏襲）
- 該当データが無い場合（未実装ファームウェア等）は`jointAngle`を`undefined`のままにし、
  レンダラー側で「未対応」表示にフォールバックさせる

### `control-app-client.ts`
- `COMMANDS`Setに`"MOVE_DEG"`/`"MOVETO_DEG"`/`"POT_ZERO_SET"`/`"POT_ZERO_CLEAR"`を追加する
  （追加しないと`sendCommand`がガードで弾いてしまう）

### レンダラー：関節検証パネル（新規セクション、`renderer.ts`・`index.html`・`styles.css`）
- マッピング済みの全論理軸について、パネルを1つずつ並べて表示する新規セクションを追加する
  （既存のF-RAM-CTRL Control Panelとは別のDOM領域。ダッシュボードの下、または専用タブ/セクションとして
  配置する。既存のセクション構成に合わせて自然な位置を選ぶこと）
- 未割当の論理軸はグレーアウトして「未割当」と表示する（F-RAM-MAP-02の既存パターンを踏襲）
- **センサ値ブロック**：`jointAngle`があれば`potDegRaw`/`potDegZeroed`/`encDeg`/`posDeg`の4値を表示、
  なければ「未対応」表示
- **モータ制御ブロック**：
  - プラス/マイナス回転ボタン：動作ステップ欄の値に応じて`MOVE_DEG`をワンショット発行（角度モード時）
  - 動作ステップのモード切替（角度／連続）：
    - 角度モード：数値入力（既定1.0°）＋プラス/マイナスボタンでワンショット`MOVE_DEG`
    - 連続モード：プラス/マイナスボタンを押している間`VEL`を継続発行、離すと`STOP`
      （既存の`jog-positive`/`jog-negative`の`onpointerdown`/`onpointerup`実装をこのパネル用に複製・
      軸ごとに独立させる。既存のControl Panelのジョグ状態（`jogging`/`joggingAxis`等のモジュール変数）は
      単一軸前提のため、複数パネル同時操作に対応できるよう軸ごとに状態を持たせること）
  - 角度入力：数値入力＋実行ボタンで`MOVETO_DEG`を発行
  - 0位置設定ボタン：`POT_ZERO_SET`を発行。実行前に確認ダイアログを表示する（`maintenanceConfirmation`と
    同様の不可逆操作確認パターンを踏襲）
  - 0位置クリアボタン：`POT_ZERO_CLEAR`を発行。確認ダイアログなし
  - `controlConnected`が`false`の間は、このブロック全体（ボタン・入力欄）を無効化する
    （センサ値ブロックは無効化しない）

### 非機能要件（本Phase範囲）
- 論理軸12個分のパネルを同時表示してもUIが破綻しないこと（既存ダッシュボードと同程度の負荷）
- IPC切断中もパネル全体がクラッシュしないこと

## 成果物
- `src/shared/types.ts`（型追加）
- `src/main/adapters/stepping-motor-ble-adapter.ts`（Joint Angleパース追加）
- `src/main/adapters/control-app-client.ts`（`COMMANDS`Set拡張）
- `src/main/device-manager.ts`（`AxisSnapshot.jointAngle`集約）
- `src/renderer/renderer.ts`・`index.html`・`styles.css`（関節検証パネルUI）
- `README.md`追記（本パネルの前提条件・ファームウェア/制御アプリ未対応時の表示について）

## 完了条件（Definition of Done）
- マッピング済みの論理軸ごとに、センサ値4値（POT補正なし・POT補正あり・エンコーダ角度・ドライバ角度）が
  表示されることを確認する（実機BLE接続、または可能であればモックデータでの表示確認）
- プラス/マイナス回転ボタン（角度モード・連続モード）・角度入力・0位置設定/クリアが、
  制御アプリIPC経由で正しいコマンド（`MOVE_DEG`/`MOVETO_DEG`/`VEL`/`STOP`/`POT_ZERO_SET`/`POT_ZERO_CLEAR`）
  を発行することを確認する（モックIPCサーバー等での疎通確認でも可）
- 制御アプリ未接続時にモータ制御ブロックのみグレーアウトし、センサ値ブロックは表示を継続することを確認する
- ファームウェア側が未対応（Joint Angleキャラクタリスティック無し）の場合に「未対応」表示へ
  フォールバックし、アプリがクラッシュしないことを確認する
- 既存のF-RAM-CTRL Control Panel（ジョグ/MOVE/MOVETO/SYNC_MOVE）に回帰がないことを確認する
- 実装後、変更ファイル一覧と動作確認方法（または未確認事項）を簡潔に報告すること
