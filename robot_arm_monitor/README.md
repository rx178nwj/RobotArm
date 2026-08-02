# Robot Arm Monitor

RobotArm2 統合モニタの Phase 9 実装です。複数の`multi_i2c_bridge`を
USB-CDCで個別に接続する機能に加え、複数のSteppingMotorDriverへBLEで接続し、
読み取り専用テレメトリを監視できます。モーション操作はSteppingMotorDriverへ
直接送信せず、Windows Named Pipe経由で別プロセスの制御アプリへ中継します。

## 起動

Windows 10/11 と Node.js が必要です。

```powershell
cd robot_arm_monitor
npm install
npm start
```

## Windows配布物の生成（Phase 5）

Windows 10/11 x64向けのNSISインストーラを生成できます。

```powershell
cd robot_arm_monitor
npm install
npm run dist
```

TypeScriptのビルド後、`release/Robot-Arm-Monitor-Setup-0.1.0.exe`が生成されます。
`serialport`はN-API対応のWindows x64プリビルドを同梱し、ASAR外へ展開するため、
Visual Studio Build Toolsを必要とするソース再構築は行いません。インストール先は
セットアップ画面で変更できます。

アプリアイコンを再生成する場合は次を実行します。

```powershell
npm run build:icon
```

配布物にはコンパイル済みの`dist/`と実行時依存だけを含め、`src/`、`test/`、
`docs/`などの開発用ファイルは含めません。コード署名は未設定のため、Windowsによって
未署名アプリの警告が表示される場合があります。

Phase 6で追加した`@stoprocent/noble`のWinRT N-APIプリビルドもASAR外へ展開します。
Phase 6時点の配布物によるBLE実機検証は未実施です。制御アプリIPC、統合ダッシュボード
などを追加した後の最終パッケージ化はPhase 10で別途行います。

画面のポート一覧では USB VID `2e8a` を bridge 候補として表示します。候補以外も
手動指定できますが、接続の確定には常に次の応答が必要です。

```text
IDENTITY product=multi_i2c_bridge id=<16桁の16進ID> protocol=1
```

接続後、送信した `identity` / `status` と受信した全行が時刻付きでログ表示されます。
複数のbridgeを接続した場合は「接続中の基板」から表示対象を切り替えます。

## SteppingMotorDriver BLE接続

BLE Centralには
[`@stoprocent/noble`](https://github.com/stoprocent/noble) 2.5系を採用しています。
旧`noble`本家や`noble-uwp`と比べて現在も更新され、TypeScript型、Windows 10/11の
WinRT binding、Service UUIDスキャンフィルタ、GATT Read/Notify、N-APIプリビルドを
提供しており、ElectronメインプロセスにBLE処理を閉じ込められるためです。

Windowsではライブラリに明示的なpair/bond APIがないため、LE Secure Connections +
Just Worksの初回ペアリングをWindows標準UIに委譲します。

1. Windowsの「設定 > Bluetoothとデバイス > デバイスの追加 > Bluetooth」で
   `SMD-<board_id>`を選択し、ペアリングします。
2. 本アプリの「SteppingMotorDriver BLE」で「BLEをスキャン」を押します。
3. 候補の「接続」を押します。アプリはAdvertisingのService UUIDで一次分類した後、
   暗号化されたDevice Infoを読み、`product=stepping_motor_driver`とboard IDを検証します。
4. 接続後はAxis Status、Power/ADC、Fault Info、Gear Angleの初期値を読み、Notifyを送受信ログと
   基板パネルに表示します。ボンディング済みならWindowsが保存した鍵で再接続します。

正式なテレメトリService UUIDはファームウェア実装と同じ
`7c9e1000-6a3d-4b89-a712-5f4e8d2c0100`です。Device Info/Axis Status/
Power/ADC/Fault Info/Gear Angleには末尾系列`1001`〜`1005`を使用します。

BLEアダプタは読み取り専用です。GATTへのアプリデータ書き込みやENABLE/MOVE/JOG/
ESTOP等のコマンド経路はなく、`sendCommand`/`executeCommand`を呼ぶと例外になります。
Notify有効化に必要なCCCD操作だけをBLEライブラリへ委ねます。

## 制御アプリIPCとモーション操作

起動時からWindows Named Pipe `\\.\pipe\robotarm-control-app`への接続を試み、切断中は
3秒間隔で自動再接続します。制御アプリが未起動または切断中の場合、「モーション制御」
パネルはESTOPを含めて全てグレーアウトします。これはBLEへ書き込みを迂回させないための
仕様であり、制御アプリが応答不能な場合は本アプリからESTOPできない点が残存リスクです。

操作前に「軸マッピング設定」で論理軸へMotor基板とローカル軸（0〜2）を割り当てて
保存してください。ENABLE/DISABLE、STOP、STOP_FREE、CLEAR_FAULT、HOME、押下中ジョグ、
MOVE、MOVETOは選択した論理軸を基板IDとローカル軸へ変換して送信します。SYNC_MOVEは
同じMotor基板に割り当てた2〜3軸だけをまとめて送信できます。制御アプリのERR応答は
エラーコードとメッセージを変換せず表示します。ESTOP結果は基板ごとの成功・失敗として
表示します。

### モック制御アプリでの確認

制御アプリ本体は未実装のため、別ターミナルでモックIPCサーバを起動して確認できます。

```powershell
cd robot_arm_monitor
node test/mock-control-app-server.js
```

その状態で`npm start`を実行すると操作パネルが有効になります。モックは通常コマンドに
`OK`、MOVETOの値`-999`に`E006 SOFT_LIMIT`、ESTOPに成功1基板・
`NOT_CONNECTED`失敗1基板を返します。HOME後には`HOME_DONE`イベントも通知します。

接続、コマンド応答、エラー透過、非同期イベント、ESTOP集約、切断後の自動再接続は次の
スモークテストで一括確認できます。

```powershell
npm run test:phase7
```

実際の制御アプリとの結合テストは、制御アプリが未実装のため未実施です。

## Bridgeパラメータ比較

bridge接続後、「Bridge パラメータ横断比較」に各基板の`config`応答を並べて表示します。
「config を再取得」を押すと、接続中の全bridgeから次の実効値を読み直します。

- `angle_src`
- `poll_period_ms`
- `status_decim`
- `as5600_conf`
- `ch_enable`
- `dir_config`
- `dir_applied`

この画面は読み取り専用です。プロトコルに存在しない設定変更コマンドは送信しません。
`ch_enable`と`dir_config`は集約ビット値として表示し、チャンネル別の変更は従来どおり
「Bridge 保守コマンド」から行います。

## CSVログ記録

1. 記録対象のbridgeを接続します。
2. 「保存先を選んで開始」を押し、CSVファイルの保存先を選択します。
3. 記録終了時に「ログ記録を停止」を押します。

既定の記録周期は1000msです。記録中は接続中の全bridgeについて`status`、`channels`、
`master`を取得し、チャンネル0〜5を1行ずつCSVへ追記します。列はISO8601時刻、基板ID、
チャンネル番号、`PRESENT`/`ENABLE`/`OK`、`ANGLE`/`DEGREE`、`AGC`、
`READ_OK`/`READ_ERR`、`FAULT`/`CH_FAULT`、`last_activity_ms`です。

既定ファイル名は`bridge_log_YYYYMMDD_HHMMSS.csv`です。記録中に1枚のbridgeが切断
された場合、その基板の記録だけを停止し、接続中の他基板は継続します。ファイル書き込みに
失敗した場合は記録を停止し、画面にエラーを表示します。

「送受信ログ」の「CSVエクスポート」では、メインプロセスが保持している時刻付きTX/RX/
systemログを`bridge_raw_log_YYYYMMDD_HHMMSS.csv`として保存できます。

## 軸マッピング

1. 使用するbridgeを接続します。
2. 「軸マッピング設定」でAxis 1〜12の表示名を入力します。
3. Motor基板・ローカル軸とBridge基板・ローカルCH（0〜2）を選択します。
4. bridge直接角度へSteppingMotorDriverと同じ補正を適用するため、Gear DIRとOffsetを設定します。
5. 必要に応じて基板表示名を入力します。
6. 「マッピングを保存」を押します。

設定はCOM番号ではなく基板固有IDをキーとして`electron-store`へ保存されるため、
USB接続位置やCOM番号が変わっても引き継がれます。同じbridgeの同じCHを複数の
論理軸へ割り当てることはできません。

## Bridge保守操作

接続中の基板を選択し、「Bridge 保守コマンド」から次の操作を実行できます。

- `fault clear`
- `rescan`
- `ch <0..5> enable|disable`
- `ch <0..5> dir <0|1>`
- `mux reset`
- `reboot`

任意のコマンド文字列は送信できません。`ch dir`、`mux reset`、`reboot` は実行前に
確認ダイアログを表示します。コマンド送信後はbridgeからの`OK`または`ERR`を待ち、
結果を画面と送受信ログへ表示します。`rescan`と`mux reset`は受付応答だけで成功扱いにせず、
`status`の`cmd`がBUSYからIDLEへ戻るまで確認します。

## Phase 9 までの範囲

- Electron + TypeScriptによる開発実行
- `DeviceAdapter`共通インタフェース
- 複数`multi_i2c_bridge`の個別接続・切断・表示切替
- `identity`検証、単発`status`取得、基板別送受信ログ
- 最大12軸の動的マッピングと基板ラベルの永続化
- bridge保守コマンドの型付きIPC、応答確認、基板別操作UI
- チャンネル別enable/disable・DIR設定と危険操作の確認ダイアログ
- bridgeの読み取り専用`config`取得と複数基板の横断比較
- bridgeの`status`/`channels`/`master`定期スナップショットCSV記録
- 時刻付き送受信ログのCSVエクスポート
- SteppingMotorDriverのBLEスキャン、候補選択、単一基板接続
- Device Infoによる識別確定とAxis Status/Power/Fault InfoのRead・Notify
- Windows標準UIへ委譲したJust Worksペアリングとボンディング済み再接続
- USB/BLEアダプタを同じ`DeviceAdapter`として管理
- BLE書き込みコマンドを持たない読み取り専用設計
- Windows Named Pipeによる制御アプリIPCクライアントと切断時の自動再接続
- 論理軸から基板ID・ローカル軸への変換を伴うモーションコマンド中継
- ジョグ、MOVE、MOVETO、同一基板SYNC_MOVE、基板別ESTOP結果表示
- 制御アプリ未接続時の操作パネル無効化と非同期制御イベント表示
- 動的な`RobotArmSnapshot`合成と論理軸横断サマリー
- 軸詳細のモーター／ギア診断表示と基板単位の生データビュー
- Gear Angle BLE Read/Notifyとbridge直接角度の補正付き突合
- `IDLE`時限定・1.0°閾値・0/360°境界対応のギア角度警告
- ヘッダー常設の全基板ESTOP集約ボタン
- uPlotによる軸詳細5チャート（速度、位置/エンコーダ、偏差、電流/電圧、ギア角度）
- 速度・偏差・電流・電圧・ギア角度差分を選べる最大12軸の横断比較
- 10/30/60/300秒幅、一時停止、カーソル確認、ギア差分閾値ライン

Phase 10の最終パッケージ化は未実装です。

Phase 8の合成ロジックは`npm run test:phase8`、Phase 9のトレンドバッファと画面契約は
`npm run test:phase9`で確認できます。

## 接続できない場合

`Access denied`と表示された場合は、同じCOMポートを別のモニタアプリ、
シリアルターミナル、または以前起動した本アプリが使用しています。該当アプリを
閉じてから「ポートを再読込」し、再度接続してください。

BLE接続で`Access denied`、`Unreachable`、暗号化・認証関連のエラーが表示された場合は、
Windows標準UIで`SMD-<board_id>`を一度削除して再ペアリングし、本アプリで再スキャンして
ください。Bluetoothがオフ、未対応、または許可されていない場合も、スキャンエラーを
画面に表示し、アプリ全体は終了しません。
