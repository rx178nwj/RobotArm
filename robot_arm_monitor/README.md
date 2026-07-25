# Robot Arm Monitor

RobotArm2 統合モニタの Phase 2 実装です。複数の`multi_i2c_bridge`を
USB-CDCで個別に接続し、基板固有IDを使った最大12軸のマッピングを保存できます。

## 起動

Windows 10/11 と Node.js が必要です。

```powershell
cd robot_arm_monitor
npm install
npm start
```

画面のポート一覧では USB VID `2e8a` を bridge 候補として表示します。候補以外も
手動指定できますが、接続の確定には常に次の応答が必要です。

```text
IDENTITY product=multi_i2c_bridge id=<16桁の16進ID> protocol=1
```

接続後、送信した `identity` / `status` と受信した全行が時刻付きでログ表示されます。
複数のbridgeを接続した場合は「接続中の基板」から表示対象を切り替えます。

## 軸マッピング

1. 使用するbridgeを接続します。
2. 「軸マッピング設定」でAxis 1〜12の表示名を入力します。
3. Bridge基板とローカルCH（0〜2）を選択します。
4. 必要に応じて基板表示名を入力します。
5. 「マッピングを保存」を押します。

設定はCOM番号ではなく基板固有IDをキーとして`electron-store`へ保存されるため、
USB接続位置やCOM番号が変わっても引き継がれます。同じbridgeの同じCHを複数の
論理軸へ割り当てることはできません。

## Phase 2 の範囲

- Electron + TypeScriptによる開発実行
- `DeviceAdapter`共通インタフェース
- 複数`multi_i2c_bridge`の個別接続・切断・表示切替
- `identity`検証、単発`status`取得、基板別送受信ログ
- 最大12軸の動的マッピングと基板ラベルの永続化

統合ダッシュボード、常時ポーリング、グラフ、bridge保守コマンドGUI、
SteppingMotorDriver/BLE、制御アプリIPCは未実装です。

## 接続できない場合

`Access denied`と表示された場合は、同じCOMポートを別のモニタアプリ、
シリアルターミナル、または以前起動した本アプリが使用しています。該当アプリを
閉じてから「ポートを再読込」し、再度接続してください。
