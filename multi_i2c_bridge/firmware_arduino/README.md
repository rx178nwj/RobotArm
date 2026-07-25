# multi_i2c_bridge Arduino Firmware

`arduino-pico` コアで RP2040 向けにビルドする Arduino 版ファームウェアです。

## 前提

- Arduino IDE 2.x または PlatformIO
- ボードコア: **Earle Philhower `arduino-pico`**
  - 参考: `arduino-pico` は RP2040 で `setup1()/loop1()` によるマルチコアと `Wire` の master/slave を提供します。
  - 本実装では Arduino ビルド環境上で **pico-sdk ヘッダも併用**しています。

## ビルド対象

- スケッチ: `firmware_arduino.ino`
- 想定ボード: Raspberry Pi Pico / RP2040

## ピン割り当て（6ch版）

- Upstream I2C target: `GP0=SDA`, `GP1=SCL`, addr `0x42`
- Downstream I2C controller: `GP2=SDA`, `GP3=SCL`
- `MUX_RESET`: `GP4`
- `DIR`: `GP5`(ch0), `GP6`(ch1), `GP7`(ch2), `GP8`(ch3), `GP9`(ch4), `GP10`(ch5)
- Onboard Blue LED: `GP25`
- Onboard Yellow LED: `GP27`
- Onboard Red LED: `GP28`
- Onboard WS281: `GP29`

ピン配置・DIR極性の詳細は [../docs/design_spec.md](../docs/design_spec.md) §6.4。

## レジスタマップ

上流I2C（0x42）のレジスタマップは6ch/v1.0（`VERSION=0x10`）で確定。`STATUS_LO`(0x02)/`STATUS_HI`(0x03)、`FAULT`(0x04)/`CH_FAULT`(0x05)、角度ブロック(0x10-0x1B)、AGCブロック(0x30-0x35)、`CH_PRESENT`(0x46)/`CH_ENABLE`(0x47)、`CMD`(0x50)等の全オフセットは [../docs/command_spec.md](../docs/command_spec.md) §3 を正とする。

## メモ

- Core0: 上流 I2C スレーブ応答、レジスタスナップショット、WDT 給餌
- Core1: 下流ポーリング、`RESCAN` / `MUX_RESET` 実行
- 未確定事項は `TODO(HW検証)` コメントで明示

## ビルド

Arduino CLIでは次のコマンドでビルドできます。

```powershell
arduino-cli compile --fqbn rp2040:rp2040:rpipico --build-path build .
```

USB診断コンソールは既定で有効です。無効化する場合はビルド定義
`MULTI_I2C_BRIDGE_USB_CONSOLE=0`を追加してください。

## ステータスLED

- GP28 Red: `FAULT`または`CH_FAULT`が非0の間点灯
- GP27 Yellow: 下流publishが継続している間、200ms周期でトグル
- GP25 Blue: 上流I2C通信が継続している間、200ms周期でトグル
- GP29 WS2812: 未使用（将来拡張用）

## USB シリアル診断

USB CDC (`115200 8N1`) にテキストコマンドと改行を送ると、通常の I2C ブリッジ動作を継続したまま状態確認と保守操作ができます。数値は10進または `0x` 付き16進で指定できます。確定コマンド仕様は [../docs/usb_serial_spec.md](../docs/usb_serial_spec.md) を正とする。

| コマンド | 内容 |
|---|---|
| `help` | コマンド一覧 |
| `status` | STATUS_LO/HI、FAULT/CH_FAULT、接続/有効マスク(6ch)、サンプル数、稼働時間、バス復旧/MUXリセット/再検出回数 |
| `channels` | 各ch(0-5)の接続、有効、通信OK、DIR設定/実出力、角度、度数、AGC、磁石状態、読取成功/失敗回数と最終時刻 |
| `config` | 角度ソース、巡回周期、AGC間引き、AS5600 CONF、CH/DIR設定(6ch) |
| `monitor 1000` / `monitor off` | 指定周期(ms)で `status` と `channels` を継続表示 / 停止 |
| `identity` / `identity set <16hex>` | Monitorの自動再接続に使う永続基板IDを表示 / 製造時に設定 |
| `master` / `master clear` | 上流マスターのI2C通信カウンター表示 / カウンターとログ消去 |
| `log [件数]` / `log clear` | 上流マスターからの直近通信ログ表示（最大64件）/ 消去 |
| `stats clear` | 下流バスと各chの診断カウンターを消去 |
| `rescan` | TCA9548A配下のAS5600を再検出 |
| `fault clear` | ラッチ済みFAULT/CH_FAULTを消去 |
| `mux reset` | TCA9548Aをリセット |
| `ch N enable` / `ch N disable` | ch N(0-5)の通常巡回を有効 / 無効化（全ch無効は禁止） |
| `ch N dir 0|1` | ch N(0-5)のDIR出力を設定して即時反映 |
| `ch N read REG [LEN]` | Core1経由でch N(0-5)のAS5600レジスタを1～8バイト読み出し |
| `ch N write REG BYTE...` | Core1経由でch N(0-5)のAS5600レジスタへ1～8バイト書き込み |
| `reboot` | ウォッチドッグ再起動 |

`channels` の磁石状態はAS5600 STATUSレジスタの値で、`MD=1` が磁石検出、`ML=1` が磁界不足、`MH=1` が磁界過大です。AGCと磁石状態は `STATUS_DECIM` 巡回ごとに更新されます。

上流ログは固定長リングバッファに保持されます。`W` はレジスタポインタと書込データ、`R` は返却したレジスタと1バイトを示します。I2C割込み内でUSB出力は行いません。

### 生センサ書き込みの注意

`ch N write` は故障解析用です。AS5600の永久書込みを防ぐためBURNレジスタ `0xFF` への書き込みは禁止しています。それ以外の設定レジスタを直接変更すると、ブリッジが管理する `AS5600_CONF` と実デバイス値が一時的に不一致になる場合があります。通常の設定変更には上流レジスタまたは既定の保守コマンドを使用してください。
