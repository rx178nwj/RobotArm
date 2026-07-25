# multi_i2c_bridge ⇔ PC Monitor 接続手順書

`multi_i2c_bridge`（RP2040ブリッジ基板）とPC上の Monitor アプリ（`monitor_app`）をUSBで接続し、画面で角度・状態を確認するまでの一連の手順と、トラブル時の切り分け方法をまとめた独立ドキュメント。

| 項目 | 内容 |
|------|------|
| 対象読者 | 実機デバッグ・製造検査・現場調整を行う開発者 |
| 前提知識 | 本書は接続作業のHow-toに特化する。プロトコル仕様は[usb_serial_spec.md](usb_serial_spec.md)、Monitorの設計仕様は[monitor_app_spec.md](monitor_app_spec.md)、基板の電気仕様は[design_spec.md](design_spec.md)を正とする |
| 対象アプリ | `multi_i2c_bridge/monitor_app`（Electron製、[README.md](../monitor_app/README.md)） |
| 対象ファームウェア | `multi_i2c_bridge/firmware_arduino/firmware_arduino.ino`（USB診断コンソール有効ビルド） |

---

## 1. 全体の接続関係

```
[PC]                      USB (単線)                  [multi_i2c_bridge 基板]
 Monitorアプリ  ◄───────────────────────────────►  USB-CDC (115200 8N1相当)
 (serialport)         COM3 / /dev/ttyACM0 等              RP2040
```

- PCとブリッジ基板は **USBケーブル1本**で直結する（上位コントローラ用の上流I2C配線とは無関係の別チャネル）。
- ブリッジ基板は上流I2C（Controller⇔ブリッジ, 0x42）・下流I2C（ブリッジ⇔TCA9548A⇔AS5600）も同時に動作させたまま、USBシリアルで監視できる（[usb_serial_spec.md](usb_serial_spec.md) §1の設計原則）。**Monitor接続のためにロボットアーム側の配線を外す必要はない**。
- 複数関節（複数ブリッジ）を同時に監視する場合は、基板ごとに1本ずつUSBケーブルをPCへ接続する（[monitor_app_spec.md](monitor_app_spec.md) §4.3、上限なし）。

---

## 2. 事前準備

### 2.1 ハードウェア

- [ ] ブリッジ基板に3.3V系電源が供給されていること（USBバスパワーのみで動作確認する場合は上流/下流センサ系も含めて電源設計を確認、[design_spec.md](design_spec.md) §6.1）。
- [ ] USBケーブル（データ通信対応、充電専用ケーブルは不可）。
- [ ] Windowsの場合：ドライバは`arduino-pico`コアの標準USB-CDCクラスドライバで、通常追加インストール不要（デバイスマネージャに「USBシリアルデバイス」として認識される）。
- [ ] Ubuntuの場合：実行ユーザーが`dialout`グループに所属していること（未所属だと`/dev/ttyACM*`を開けずMonitor起動時にエラーになる、[monitor_app_spec.md](monitor_app_spec.md) §3, §6.4）。

```bash
# Ubuntu: dialoutグループ確認・追加（追加後は再ログインが必要）
groups $USER
sudo usermod -aG dialout $USER
```

### 2.2 ファームウェア

- [ ] USB診断コンソールが有効なビルドであること（既定で有効。`MULTI_I2C_BRIDGE_USB_CONSOLE=0`を指定していないか確認、[firmware_arduino/README.md](../firmware_arduino/README.md)）。
- [ ] 量産・複数台運用時は基板固有ID（`identity`）がプロビジョニング済みであること（未設定でも動作はするが、外付けフラッシュID由来のためID重複のリスクがある、[design_spec.md](design_spec.md) §5.4 USB-ID-03/05）。同時接続する全基板のIDが重複しないことを`identity`コマンドで事前確認しておくと後述のトラブルを避けられる。

### 2.3 Monitorアプリのセットアップ

初回のみ依存パッケージを導入する。

```powershell
cd multi_i2c_bridge/monitor_app
npm.cmd install
```

起動：

```powershell
npm.cmd start
```

`npm start`は`tsc`ビルド→静的ファイルコピー→Electron起動を一括実行する（[README.md](../monitor_app/README.md)、`package.json`の`start`スクリプト）。ビルド済み資産のみ再起動したい場合は`npm.cmd run build`の後に`electron .`でも良い。

---

## 3. 接続手順（画面操作）

1. ブリッジ基板をUSBケーブルでPCに接続する。OSがCOMポート（Windows）または`/dev/ttyACM*`（Ubuntu）として認識するまで数秒待つ。
2. Monitorアプリを起動する（§2.3）。起動時に自動でシリアルポート一覧を走査し、以降3秒周期で再走査する。
3. 左サイドバー **DETECTED DEVICES** に検出済みポートが一覧表示される。
   - `RP2040 candidate` と表示された行が、VID/PIDからRP2040 USB-CDCと推定されたポート（未確定、identityは未送信の状態）。
   - 一覧に何も出ない場合は §5.1「ポートが一覧に出てこない」を参照。
   - 一覧の右上の `↻` ボタンで手動再走査できる。
4. 対象ポート行の **Connect** ボタンをクリックする。
   - Monitorは自動全接続を行わない（他プロセスが同一ポートを使用中の可能性があるため、[monitor_app_spec.md](monitor_app_spec.md) §4.1）。接続したい基板を都度明示的に選ぶ。
   - 接続処理中はボタンが `Connecting…` になり、サイドバー下の接続メッセージ欄に進捗が表示される。
   - 内部では`identity`コマンドを送信し、`multi_i2c_bridge`からの正しい応答（製品名・基板ID・プロトコル版）を確認できて初めて接続確立とみなす（VID/PIDだけでは確定しない、[design_spec.md](design_spec.md) MON-CON-02）。
5. 自動検出に出てこないポートは、サイドバー下部の手動入力欄（`COM34 / /dev/ttyACM0`のプレースホルダ）にポート名を直接入力し、隣の **Connect** ボタンで接続できる。
6. 接続に成功すると **CONNECTED** セクションにデバイスが追加され、接続メッセージが緑（成功）表示になる。デバイス行をクリックするとメイン画面に詳細（角度ゲージ、時系列波形、chステータステーブル、上流I2Cパネル）が表示される。
7. 画面上部の **Period** で更新周期[ms]（100〜60000、既定1000）を設定し、**Start all** で全接続デバイスの`monitor`を一括開始、**Stop all**で一括停止する。**Grid** ボタンで単一デバイス表示⇔複数デバイス並列表示（ミニパネル）を切り替えられる。

### 3.1 正常動作時の見え方

- ヘッダのステータスチップ：`USB: monitoring`（緑）、`MASTER: active`（緑、上位コントローラが通信中の場合）、`SENSORS: ok`（緑、全ch正常時）。
- 各chゲージに角度[°]とAGC値が表示され、Period周期で更新され続ける。
- 波形パネルにch別の折れ線が伸びていく。

---

## 4. 動作確認チェックリスト

接続後、以下を順に確認すると全区間（USB／上流I2C／下流I2C）の切り分けができる（[monitor_app_spec.md](monitor_app_spec.md) §5.2の3階層表示に対応）。

| # | 確認項目 | 正常な状態 | 異常時に疑う箇所 |
|---|---------|-----------|----------------|
| 1 | `USB:` チップ | `monitoring`（緑） | USBケーブル・ポート・ファームウェアのUSBコンソール有効化（§5.2） |
| 2 | `MASTER:` チップ | 上位コントローラ動作中なら`active`（緑）。上位未接続なら`idle`（黄）で正常 | `idle`のまま変化しない＝上流I2C配線・上位側ドライバ（§5.3） |
| 3 | `SENSORS:` チップ | 使用ch数分`ok`（緑） | `fault`（赤）＝下流I2C・AS5600個体・磁石アライメント（§5.4） |
| 4 | 各chゲージ | 角度が滑らかに変化 | 特定chのみ`invalid`／固定値＝当該chのDIR配線・プルアップ・AS5600実装（[design_spec.md](design_spec.md) §6.2, §6.4） |

---

## 5. トラブルシューティング

### 5.1 ポートが一覧に出てこない

- USBケーブルがデータ通信対応か確認（充電専用ケーブルでは通信できない）。
- Windows: デバイスマネージャで「ポート(COM と LPT)」配下に認識されているか確認。認識されない場合はケーブル/ポート/基板側USBコネクタのはんだ・実装不良を疑う。
- Ubuntu: `ls /dev/ttyACM*` で存在確認。存在するが権限で開けない場合は §2.1 の`dialout`グループ設定を確認し、**再ログイン（またはOS再起動）**してから再試行する（グループ変更はセッション再取得まで反映されない）。
- 一覧はRP2040 USB-CDCの候補のみを`RP2040 candidate`表示するが、それ以外のUSBシリアルデバイス（別用途のCDC機器等）も列挙対象になる。目的の基板か判別できない場合は§3手順4の手動接続で直接ポート名を指定し、`identity`応答の内容で確認する。

### 5.2 Connectを押すとエラーになる／タイムアウトする

- 接続メッセージに `Could not open <path>: ...` が出る場合：
  - 他のアプリ（Arduino Serial Monitor、PuTTY、別のMonitorインスタンス等）が同じポートを掴んでいないか確認する。シリアルポートは同時に1プロセスしかオープンできない。
  - Windowsでポート番号（COMxx）が変わっていないか確認する（USB抜き差し後は番号が変わることがある。§5.1参照の上で再走査`↻`）。
- `identity response timeout` 系のエラーの場合：
  - ファームウェアがUSB診断コンソール無効ビルド（`MULTI_I2C_BRIDGE_USB_CONSOLE=0`）になっていないか確認する（[firmware_arduino/README.md](../firmware_arduino/README.md)）。無効ビルドでは`identity`に応答しないため、意図的に有効ビルドへ書き直す必要がある。
  - ファームウェアが古く`identity`コマンド未実装の可能性がある。ファームウェアを最新（6ch版, [usb_serial_spec.md](usb_serial_spec.md)準拠）へ更新する。
  - 基板が再起動ループ・フォルト状態でUSB-CDC自体が安定していない可能性がある。基板上のRed LED（GP28）点灯有無を確認する（§5.4のLED診断も参照）。

### 5.3 `MASTER: idle` から変化しない（上流I2Cが動いていない）

- 上位コントローラ側の配線（上流I2C0 SDA=GP0, SCL=GP1）・電源・アドレス`0x42`向けの通信発行を確認する（[design_spec.md](design_spec.md) §4, §6.4）。
- 上位コントローラを未接続のまま単体でブリッジ基板の動作確認をしている場合は、`idle`が正常表示である（上位が繋がっていないだけ）。上位実機を接続してから再確認する。
- Monitor上で`master`相当の詳細パネル（上流I2Cパネル）の`write_tx`/`read_req`カウンタが0のまま増加しない場合、上流バスの物理的な導通（プルアップ含む、[design_spec.md](design_spec.md) §6.2）を確認する。

### 5.4 特定chが `SENSORS: fault` または `invalid` のまま

- 基板上のRed LED（LED_STAT1, GP28）が点灯している場合、`FAULT`または`CH_FAULT`が非0（[design_spec.md](design_spec.md) §10）。デバイス詳細画面の`FAULT:`/`CH_FAULT:`表示でどの種別かを確認する。
- 該当chのAS5600取付・磁石アライメント不良の可能性がある。MonitorのAGC/磁石状態（MD/ML/MH）はv0.1のUI範囲外だが、同等情報はUSBシリアルのターミナル直接操作（`channels`コマンド、[usb_serial_spec.md](usb_serial_spec.md) §4.3）で確認できる。Monitor接続中でも他ツールから同時に同じポートへコマンドは送れない点に注意（ポートは1プロセス専有）。一時的にMonitorを切断してからターミナルソフトで確認するか、Monitorの`Stop all`後にデバイス切断してから確認する。
- 下流I2C配線・プルアップ（ch毎の2.2k〜4.7kΩ、10kΩ不可）を確認する（[design_spec.md](design_spec.md) §6.2の根拠付き規定）。

### 5.5 監視中に通信が途切れる／再接続がうまくいかない

- Monitorは物理切断を検知すると即座に未接続表示へ遷移し、以後1秒周期でRP2040候補ポートを再走査、`identity`の基板IDが切断前と一致した場合のみ自動再接続する（[design_spec.md](design_spec.md) MON-CON-03〜06、[monitor_app_spec.md](monitor_app_spec.md) §6.2）。
- 自動再接続が成立しない場合に疑う点：
  - 同一基板IDを持つ基板が複数台同時接続されている（[design_spec.md](design_spec.md) USB-ID-05）。`identity`を各基板で個別に確認し、重複していれば`identity set <16hex>`で再プロビジョニングする（製造時のみを想定した操作、通常運用では実施しない）。
  - USBハブ配下でポートが安定せず頻繁に列挙が変わる。可能であればPC本体のUSBポートに直結して切り分ける。
- タイムアウト判定は更新周期の3倍が目安（[monitor_app_spec.md](monitor_app_spec.md) §5.2.1）。極端に長いPeriod設定（例: 60000ms）にしていると、実際の通信断から表示反映まで数分かかる点に注意。

### 5.6 複数台接続時に別の関節のデータに見える／ラベルが混同する

- デバイス識別はポート名ではなく`identity`の基板固有IDに基づく（[monitor_app_spec.md](monitor_app_spec.md) §4.2）。表示ラベル（例：「J1 shoulder」）は基板IDに紐づけて設定ファイルへ保存されるため、初回接続時に必ずラベル設定（表示名変更UI、デバイス一覧の各行）を行い、以後はUSB挿し直しやポート番号変化があっても同じラベルで表示され続けることを確認する。
- ラベル未設定のままだと基板IDの下6桁が表示名になる（`labelFor`の既定挙動）。複数台を扱う現場では接続直後に必ずラベル付けする運用にすると事故を防げる。

### 5.7 Ubuntuでアプリ自体が起動しない／シリアルアクセスで例外が出る

- `serialport`パッケージはネイティブモジュールを含むため、`npm.cmd install`相当（Ubuntuでは`npm install`）実行時にビルドツール（`build-essential`等）が必要な場合がある。インストールログのビルドエラーを確認する。
- `dialout`グループ未所属時のエラーダイアログには対処法（グループ追加コマンド）が案内される設計になっている（[monitor_app_spec.md](monitor_app_spec.md) §6.4）。案内どおり設定後、**ログアウト/ログインし直してから**再起動する。

---

## 6. 関連ドキュメント

| ドキュメント | 内容 |
|---|---|
| [usb_serial_spec.md](usb_serial_spec.md) | USB-CDCテキストコマンドプロトコルの確定仕様（`identity`/`status`/`channels`等） |
| [monitor_app_spec.md](monitor_app_spec.md) | Monitorアプリの設計仕様（UI・デバイス管理・再接続ロジック） |
| [design_spec.md](design_spec.md) | 基板の電気仕様・GPIO配線・LED診断（§6, §10） |
| [../firmware_arduino/README.md](../firmware_arduino/README.md) | ファームウェアのビルド方法・USB診断コンソールのコマンド一覧 |
| [../monitor_app/README.md](../monitor_app/README.md) | Monitorアプリの起動方法（開発者向け簡易版） |
