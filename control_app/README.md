# Robot Arm Control App — Phase 1

SteppingMotorDriver の USB-CDC 接続を専有し、`robot_arm_monitor` からのモーション制御要求を
Windows Named Pipe (`\\.\pipe\robotarm-control-app`) 経由で中継する Electron アプリです。

## セットアップと起動

```powershell
cd control_app
npm install
npm start
```

起動後はシリアルポートを3秒周期で列挙し、各候補へ115200 baudで接続して `GET BOARD_ID` に
正しく応答した SteppingMotorDriver のみを管理します。固定VID/PIDは要求仕様で未定義のため、
判定には基板ID応答を使用します。別のアプリが使用中のポートや対象外デバイスの探索失敗はログに残り、
サーバー動作は継続します。

## 実機なしの動作確認

```powershell
npm test
```

テストは2台のDuplexモック基板と一時Named Pipeを使用し、次を検証します。

- §4.2の全コマンド（`MOVE_DEG` / `MOVETO_DEG` / `POT_ZERO_SET` / `POT_ZERO_CLEAR`を含む）の
  ルーティングと応答
- `ERR E006 SOFT_LIMIT` の透過、未接続時の `NOT_CONNECTED`、無応答時の `TIMEOUT`
- `HOME_DONE` の非同期イベント転送
- 2台への並列ESTOPと、片方が無応答の場合の結果集約
- 2本目のIPCクライアントの拒否

実際の `robot_arm_monitor` の `NamedPipeControlAppClient` を使用する結合試験は、次のコマンドで
両プロジェクトをビルドしてから実行します。

```powershell
npm run test:integration
```

実機で動作を開始しないUSB-CDCスモーク試験（`GET BOARD_ID`と全軸`STOP`）を行う場合は、
SteppingMotorDriverのCOMポートを指定します。

```powershell
$env:ROBOTARM_PORT="COM41"
npm run test:hardware
```

安全確認後に相対角度の往復動作を試験する場合は、確認フラグと最大10度の試験角度を指定します。

```powershell
$env:ROBOTARM_PORT="COM41"
$env:ROBOTARM_AXIS="0"
$env:ROBOTARM_TEST_DEG="10"
$env:ROBOTARM_TEST_GEAR_RATIO="1"
$env:ROBOTARM_MOTION_CONFIRMED="YES"
npm run test:hardware:motion
```

`ROBOTARM_TEST_GEAR_RATIO` は、実機ファームウェアの `gear_ratio` が未設定の場合に限る試験用補償です。
通常運用ではファームウェア側のギア比を正しく設定し、`1`のまま使用します。

起動済みアプリに対する手動IPC確認には次を使用できます。接続済み基板を操作する場合は環境変数へ
12桁の基板IDを指定します。

```powershell
$env:ROBOTARM_BOARD_ID="AABBCCDDEEFF"
npm run test:client
```

## Phase 1 の範囲

画面はIPCクライアント状態、接続基板、簡易ログだけを表示します。ジョグ操作、軸パラメータ編集、
USB接続管理などの操作UIは未実装です。これらは制御アプリ自身のGUI要求仕様が未確定であり、
Phase 1 の対象外です。

`robot_arm_monitor/src/main/adapters/control-app-client.ts` との実アプリ結合試験はPhase 1の必須範囲外です。
同じ改行区切りJSONプロトコルを用いるモッククライアントで互換性を検証します。
