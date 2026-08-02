# コントローラ ⇔ ブリッジ間 コマンド仕様書

上流I2Cバス（Controller ⇔ RP2040ブリッジ, 0x42）の**コマンド／レジスタインタフェース確定仕様**。
コントローラ側ドライバ実装者は本書のみでブリッジを制御できることを目標とする。

| 項目 | 内容 |
|------|------|
| 対象 | 上流I2Cバス（Host ⇔ Bridge, スレーブ 0x42） |
| 関連 | [controller_impl_notes.md](controller_impl_notes.md)（**実装注意点・未確定事項／他システム構築時 必読**） / [i2c_architecture.md](i2c_architecture.md)（通信アーキ） / [design_spec.md](design_spec.md) §5（HW/レジスタ） / [software_architecture.md](software_architecture.md)（FW構造） |
| 版 | 1.1（0位置設定レジスタ追加, §4.10） |
| 作成日 | 2026-07-10（初版）／2026-07-19 改訂（6ch化）／2026-08-01 改訂（0位置設定レジスタ追加） |

> **6ch化に伴う後方非互換変更（v1.0）**：`STATUS` は1バイトに6ch分のch別ビット＋既存フラグ（DEGRADED/DATA_NEW/MUX_FAULT/ERR）が収まらないため **2バイト(STATUS_LO/HI)化**した。FAULTのch別COMMビットは別レジスタ`CH_FAULT`(1バイト, ch0-5で収まる)に分離した。角度/AGCブロックがch3-5分拡張されオフセットが再配置されているため、**v0.x(3ch)ドライバとの互換性は無い**（§9）。
>
> **0位置設定の追加（v1.1、後方互換）**：磁石取付誤差を補正するch毎0位置オフセット機能（[design_spec.md](design_spec.md) §5.5）のため、予約領域に `ZERO_CH_SELECT`(0x52)・`CHn_ZERO_OFFSET`(0x60–0x6B) を追加し、`CMD`に`ZERO_SET`/`ZERO_CLEAR`を追加する（§4.10、§7.1）。既定オフセット=0では`CHn_ANGLE`の出力はv1.0と完全に同一のため、既存オフセットのみを使う既存ドライバへの影響はない（追加のみ、minor bump）。Arduino版ファームウェアの`VERSION`は0x11。

> **本書と関連文書の役割分担**：トランザクションの成立性・タイミング根拠は [i2c_architecture.md](i2c_architecture.md)、HW配線・電気仕様は [design_spec.md](design_spec.md)、FW内部構造は [software_architecture.md](software_architecture.md)。本書は**上流バス上を流れるバイト列（コマンド）の確定仕様**に特化する。

---

## 1. 基本モデル

ブリッジは上位に対し「**1個のレジスタマップ型I2Cセンサ**」として振る舞う（[i2c_architecture.md](i2c_architecture.md) §1）。

- 上位（Controller）＝ **Master**、ブリッジ（RP2040）＝ **Slave（7bit アドレス 0x42）**。
- アクセスは **8bitレジスタポインタ + auto-increment** の一般的手順。ポインタを書いてから読む／書く。
- 下流（TCA9548A / AS5600 / ポーリング）は**完全に隠蔽**。上位はレジスタread/writeのみ。
- **生I2Cのみ**（SMBus非対応：PEC/ARAなし）。特別なコマンドプロトコルは不要で、Linux `i2c-dev` 等の標準ドライバで扱える。

### 1.1 バスパラメータ（要約 / 確定値）

| 項目 | 値 |
|------|-----|
| スレーブアドレス | **0x42**（7bit, `board.h` 定数化） |
| 速度 | **400 kHz (Fast)**（将来 1MHz FM+ 移行余地あり） |
| バイトオーダ | **リトルエンディアン (LE)** |
| ポインタ | 8bit、read/write後に auto-increment |
| クロックストレッチ | ISRのTX準備の極短時間（µsオーダ）のみ |
| 想定読み出し頻度 | 6ch一括 12バイト（角度のみ）または15バイト（角度+ミラー）を 1 kHz |
| 起動 ready 時間 | **電源投入後 ≤100ms** で 0x42 応答開始（§8.2）。それ以前は NACK |

> 根拠は [i2c_architecture.md](i2c_architecture.md) §9。

---

## 2. トランザクション形式

`S`=START, `Sr`=Repeated START, `P`=STOP, `A`=ACK, `N`=NACK。`W`=書き(bit0=0), `R`=読み(bit0=1)。

### 2.1 書き込み（ポインタ設定 ＋ レジスタ書込）

```
S [0x42|W] A [ptr] A [d0] A [d1] A ... P
             └ ptr から auto-increment で書込（R/W レジスタのみ）
```
- データバイトを省略（`ptr` のみ）すると「ポインタ設定だけ」になり、続く読み出しの開始位置指定に使う。
- R（読み専用）領域や未定義オフセットへの書込は**無視**され、`STATUS_HI.ERR`(bit7) と `FAULT`(0x04) がセットされる（§6）。

### 2.2 読み出し（コンバインド形式・**推奨**）

```
S [0x42|W] A [ptr] A  Sr [0x42|R] A [d0] A [d1] A ... [dn] N  P
             └ 開始レジスタ指定      └ ptr から auto-increment で連続読出
```
- `Sr`（Repeated START）でポインタ設定→読み出しを1トランザクションで行う。**トランザクション開始時に全レジスタ値がラッチ**されるため、バースト読み出しは一貫スナップショット（tearなし, [i2c_architecture.md](i2c_architecture.md) §4）。

### 2.3 現在ポインタからの読み出し（ポインタ設定省略）

```
S [0x42|R] A [d0] A [d1] A ... N P
   └ 前回のポインタの続きから読める
```

### 2.4 Linux i2c-dev 実装との対応

| 操作 | 手段 |
|------|------|
| §2.2 コンバインド読み | `ioctl(I2C_RDWR)` に write(ptr) + read(n) の2メッセージを渡す |
| §2.1 書込 | `write()` に `[ptr, d0, d1, ...]` |
| SMBus API | `i2c_smbus_read_i2c_block_data(fd, ptr, n, buf)` でも可（PEC無効で使用） |

---

## 3. レジスタマップ（完全版・確定, 6ch/v1.1）

全オフセットの一覧。未定義オフセットの読みは **0xFF**、書きは**無視**。多バイト値は **LE**。

| Off | 名称 | R/W | Byte | リセット値 | 概要 |
|-----|------|-----|------|-----------|------|
| 0x00 | `WHO_AM_I` | R | 1 | 0xB6 | デバイスID（固定） |
| 0x01 | `VERSION` | R | 1 | 0x11 | FWバージョン（上位4bit=major / 下位4bit=minor, §9.1）。0位置対応6ch版=v1.1 |
| 0x02 | `STATUS_LO` | R | 1 | 0x00 | ch0-5 磁石検出OK（§4.1） |
| 0x03 | `STATUS_HI` | R | 1 | 0x00 | DEGRADED/DATA_NEW/MUX_FAULT/ERR（§4.1） |
| 0x04 | `FAULT` | R | 1 | 0x00 | ラッチ式エラー詳細（mux/バス系）。`CMD=CLEAR_FAULT`でクリア（§4.2） |
| 0x05 | `CH_FAULT` | R | 1 | 0x00 | ch0-5 COMMフォルト（ラッチ式, §4.2） |
| 0x06–0x07 | reserved | R | — | 0xFF | 予約 |
| 0x08 | `SAMPLE_COUNT` | R | 4 | 0x00000000 | publish毎に+1（LE, ラップ）。新旧判別用（§4.3） |
| 0x0C–0x0F | reserved | R | — | 0xFF | 予約（読みは0xFF） |
| 0x10 | `CH0_ANGLE` | R | 2 | 0x0000 | ch0 角度 12bit（LE, §5） |
| 0x12 | `CH1_ANGLE` | R | 2 | 0x0000 | ch1 角度 |
| 0x14 | `CH2_ANGLE` | R | 2 | 0x0000 | ch2 角度 |
| 0x16 | `CH3_ANGLE` | R | 2 | 0x0000 | ch3 角度 |
| 0x18 | `CH4_ANGLE` | R | 2 | 0x0000 | ch4 角度 |
| 0x1A | `CH5_ANGLE` | R | 2 | 0x0000 | ch5 角度 |
| 0x1C | `STATUS_LO_M` | R | 1 | 0x00 | STATUS_LO(0x02)のスナップショットミラー（§5.3） |
| 0x1D | `STATUS_HI_M` | R | 1 | 0x00 | STATUS_HI(0x03)のスナップショットミラー（§5.3） |
| 0x1E | `SAMPLE_LO` | R | 1 | 0x00 | SAMPLE_COUNT 下位1バイトのミラー（§5.3） |
| 0x1F–0x2F | reserved | R | — | 0xFF | 予約 |
| 0x30 | `CH0_AGC` | R | 1 | 0x00 | ch0 AGC値（磁石距離目安） |
| 0x31 | `CH1_AGC` | R | 1 | 0x00 | ch1 AGC値 |
| 0x32 | `CH2_AGC` | R | 1 | 0x00 | ch2 AGC値 |
| 0x33 | `CH3_AGC` | R | 1 | 0x00 | ch3 AGC値 |
| 0x34 | `CH4_AGC` | R | 1 | 0x00 | ch4 AGC値 |
| 0x35 | `CH5_AGC` | R | 1 | 0x00 | ch5 AGC値 |
| 0x36–0x3F | reserved | R | — | 0xFF | 予約 |
| 0x40 | `CONFIG` | R/W | 1 | 0x00 | 角度ソース選択等（§4.4） |
| 0x41 | `POLL_PERIOD` | R/W | 1 | 0x00 | ポーリング周期[ms]。0=全力巡回（既定, §4.5） |
| 0x42 | `DIR_CONFIG` | R/W | 1 | 0x00 | ch0-5回転方向 + APPLY_NOW（§4.6） |
| 0x43 | `STATUS_DECIM` | R/W | 1 | (FW既定) | STATUS/AGC間引き率（巡回n回に1回, §4.7） |
| 0x44 | `AS5600_CONF` | R/W | 2 | 0x0A00 | AS5600 CONFレジスタ(SF/FTH等)。LE・全ch共通。次巡で各chへ再書込（§4.8） |
| 0x46 | `CH_PRESENT` | R | 1 | (自動検出) | ch0-5 実装ビットマップ（自動検出結果, §4.9） |
| 0x47 | `CH_ENABLE` | R/W | 1 | (起動検出値) | ch0-5 有効ch選択マスク（§4.9） |
| 0x48–0x4F | reserved | R | — | 0xFF | 予約（読みは0xFF・書込は`CFG_REJECT`） |
| 0x50 | `CMD` | R/W | 1 | 0x00 | コマンド発行／実行結果（§7） |
| 0x51 | reserved | R | — | 0xFF | 予約 |
| 0x52 | `ZERO_CH_SELECT` | R/W | 1 | 0x00 | 0位置設定/クリア対象chマスク。bit0-5=ch0-5（§4.10） |
| 0x53–0x5F | reserved | R | — | 0xFF | 予約 |
| 0x60 | `CH0_ZERO_OFFSET` | R/W | 2 | 0x0000 | ch0 0位置オフセット 12bit（LE, §4.10） |
| 0x62 | `CH1_ZERO_OFFSET` | R/W | 2 | 0x0000 | ch1 0位置オフセット |
| 0x64 | `CH2_ZERO_OFFSET` | R/W | 2 | 0x0000 | ch2 0位置オフセット |
| 0x66 | `CH3_ZERO_OFFSET` | R/W | 2 | 0x0000 | ch3 0位置オフセット |
| 0x68 | `CH4_ZERO_OFFSET` | R/W | 2 | 0x0000 | ch4 0位置オフセット |
| 0x6A | `CH5_ZERO_OFFSET` | R/W | 2 | 0x0000 | ch5 0位置オフセット |
| 0x6C– | reserved | — | — | 0xFF | 予約 |

### 3.1 高速読み出しブロック（ホットパス）

`0x10` から連続配置し、**単一バーストで一貫スナップショット**を取得できる：

| 読みサイズ | 範囲 | 取得内容 | 所要(400kHz, 概算) |
|-----------|------|---------|-------------|
| **12 バイト** | 0x10–0x1B | 6ch角度のみ（**正準・最小**） | 約 340 µs |
| **15 バイト（推奨）** | 0x10–0x1E | 6ch角度 + STATUS_LO/HI_M + SAMPLEカウント下位 | 約 400 µs |

> 15バイト読みなら、角度・健全性（STATUS_LO/HI_M）・鮮度（SAMPLE_LO）を**1トランザクションの整合スナップショット**で同時取得でき、別途 0x02-0x03/0x08 を読む往復が不要。1kHz予算（1ms）に対し約40%で余裕（詳細timing根拠は[i2c_architecture.md](i2c_architecture.md) §5.5）。

---

## 4. レジスタ詳細（ビット定義）

### 4.1 `STATUS_LO`（0x02, R）／`STATUS_HI`（0x03, R）

| bit | 名称 | 意味 |
|-----|------|------|
| LO 0 | `CH0_OK` | ch0 磁石検出(MD=1)かつ下流通信OK |
| LO 1 | `CH1_OK` | ch1 同上 |
| LO 2 | `CH2_OK` | ch2 同上 |
| LO 3 | `CH3_OK` | ch3 同上 |
| LO 4 | `CH4_OK` | ch4 同上 |
| LO 5 | `CH5_OK` | ch5 同上 |
| LO 7:6 | (reserved) | 0 |
| HI 0 | `DEGRADED` | **有効ch**（`CH_ENABLE`, §4.9）のいずれかが異常（縮退運転中）。無効ch(未使用)は寄与しない |
| HI 1 | `DATA_NEW` | 前回読了後に新スナップショットをpublish済（任意, 読了でクリア） |
| HI 2 | `MUX_FAULT` | TCA9548A 異常（無応答/リセット実施） |
| HI 6:3 | (reserved) | 0 |
| HI 7 | `ERR` | いずれかのエラー発生（詳細は `FAULT`/`CH_FAULT`）。`CMD=CLEAR_FAULT`でクリア |

- `CHn_OK=0`：**有効chが無応答（故障）**の場合は該当chが**旧値保持**・`AGC=0`。上位はその値を無効として扱うこと。
- `CHn_OK` は**無効ch（`CH_ENABLE` bit=0, 未使用）でも0**になる。故障（有効かつ無応答）と未使用の判別は `CH_ENABLE` で行う（§4.9/§5.4）。無効chは `DEGRADED` に寄与しない。

### 4.2 `FAULT`（0x04, R, ラッチ式）／`CH_FAULT`（0x05, R, ラッチ式）

一度セットされると保持され、`CMD=CLEAR_FAULT`（§7）でクリア。原因の切り分け用。

**`FAULT`（0x04）** — mux/バス系の共通エラー

| bit | 名称 | 意味 |
|-----|------|------|
| 0 | `MUX_NORSP` | mux(0x70) 無応答 |
| 1 | `BUS_RECOVER` | 下流バス固着を検出し復旧手順(SCL 9パルス+STOP)を実施 |
| 2 | `CFG_REJECT` | 不正な設定書込（R領域/範囲外/無効値）を拒否 |
| 3 | `WDT_RESET` | 前回起動以降にWDTリセットが発生 |
| 4 | `PTR_RANGE` | 範囲外オフセットへのアクセスを検出 |
| 7:5 | (reserved) | 0 |

**`CH_FAULT`（0x05）** — ch別COMMエラー

| bit | 名称 | 意味 |
|-----|------|------|
| 0 | `CH0_COMM` | ch0 AS5600 NACK/timeout |
| 1 | `CH1_COMM` | ch1 同上 |
| 2 | `CH2_COMM` | ch2 同上 |
| 3 | `CH3_COMM` | ch3 同上 |
| 4 | `CH4_COMM` | ch4 同上 |
| 5 | `CH5_COMM` | ch5 同上 |
| 7:6 | (reserved) | 0 |

### 4.3 `SAMPLE_COUNT`（0x08–0x0B, R, LE, 32bit）

- 下流ポーリング1巡完了（publish）ごとに +1。0xFFFFFFFF の次は 0x00000000 にラップ。
- 上位は前回読み値との差分で**データ更新の有無・取りこぼし数**を判別できる。差=0なら未更新（オーバーサンプル読み）。
- ホットパスでは下位1バイトのミラー `SAMPLE_LO`(0x1E) で十分（1kHz読みなら255巡ラップまで一意）。

### 4.4 `CONFIG`（0x40, R/W）

| bit | 名称 | 値 | 意味 |
|-----|------|-----|------|
| 0 | `ANGLE_SRC` | 0 | **RAW_ANGLE (0x0C/0x0D)** を転送（**既定**, [as5600_config.md](as5600_config.md) §1） |
| | | 1 | フィルタ後 ANGLE (0x0E/0x0F) を転送 |
| 7:1 | (reserved) | 0 | 0固定 |

> **数値表現（確定）**：本書はホスト視点で `bit0=0→RAW（既定）` / `bit0=1→ANGLE` と定義。FW側 `config.angle_src`（[software_architecture.md](software_architecture.md) §6.3）も**同一表現（0=RAW/1=ANGLE）に統一済み**のため、`config.angle_src = CONFIG & 0x01` と素通しで対応する（反転なし）。既定は**RAW_ANGLE**（[as5600_config.md](as5600_config.md) 確定）。
> AS5600 の CONF/フィルタ確定値・根拠は [as5600_config.md](as5600_config.md)。

### 4.5 `POLL_PERIOD`（0x41, R/W）

| 値 | 意味 |
|----|------|
| 0x00 | **全力巡回（free-run）** — 既定・推奨（[i2c_architecture.md](i2c_architecture.md) §5.5.4） |
| 0x01–0xFF | 巡回の**目標最小周期[ms]**（スロットル）。指定周期より速くは回さない |

### 4.6 `DIR_CONFIG`（0x42, R/W）

各chのAS5600 DIRピン（ブリッジGPIO駆動, [design_spec.md](design_spec.md) §6.4）。

| bit | 対象 | 0 | 1 |
|-----|------|---|---|
| 0 | ch0 DIR | L: CW増加（既定） | H: CCW増加 |
| 1 | ch1 DIR | 同上 | 同上 |
| 2 | ch2 DIR | 同上 | 同上 |
| 3 | ch3 DIR | 同上 | 同上 |
| 4 | ch4 DIR | 同上 | 同上 |
| 5 | ch5 DIR | 同上 | 同上 |
| 6 | reserved | 0 | — |
| 7 | `APPLY_NOW` | — | 1で即時反映（次巡ではなく即GPIO駆動） |

- 既定 0x00 = 全ch CW増加（DIR=L）。
- **反映タイミング**：`APPLY_NOW`(bit7)=0 の書込は次巡で Core1 が DIR GPIO を駆動（[software_architecture.md](software_architecture.md) §8.2）。`APPLY_NOW`=1 は Core0 が書込受領時に**その場で DIR GPIO を直接駆動**し即時反映する（FW内部機構は [software_architecture.md](software_architecture.md) §7.1）。いずれも駆動値は `dir_config` から一意に定まり、Core0/Core1 の二重駆動でも結果は同一（冪等）。
- ⚠ 方向反転は出力に不連続（ステップ）を生じる。**切替直後のサンプルは上位が破棄**し再取得すること（[design_spec.md](design_spec.md) §6.4）。通常運用中は変更しない静的設定として扱う。

### 4.7 `STATUS_DECIM`（0x43, R/W）

STATUS/AGC の下流取得間引き率（角度は毎巡取得）。巡回 n 回に1回 STATUS/AGC を更新。既定は約100Hz相当（[software_architecture.md](software_architecture.md) §6.3）。0 は無効値として拒否（`FAULT.CFG_REJECT`）。

### 4.8 `AS5600_CONF`（0x44–0x45, R/W, LE, 16bit）

AS5600 の CONF レジスタ（16bit）をそのまま公開し、上位から SF/FTH 等を**実行時に変更**できる。主目的は **フィルタ挙動の実機評価**（RAW にフィルタが効くかの切り分け, [as5600_config.md](as5600_config.md) §3）と、ANGLE 使用時のノイズ/応答チューニング（[as5600_config.md](as5600_config.md) §8）。

- **バイト配置（LE）**：`0x44`=CONF下位（AS5600 reg 0x08 側）, `0x45`=CONF上位（AS5600 reg 0x07 側）。リセット値 **0x0A00**（SF=4x, FTH=7LSB, PM=NOM, WD=OFF）。
- **ビット定義**は [as5600_config.md](as5600_config.md) §2 に従う（PM[1:0] / HYST[3:2] / OUTS[5:4] / PWMF[7:6] / SF[9:8] / FTH[12:10] / WD[13] / reserved[15:14]）。
- **変更が許されるのは SF/FTH のみ**。それ以外のフィールド（PM/HYST/OUTS/PWMF/WD/reserved）を基準値 0x0A00 の該当ビットから変える書込は、1kHz常時測定の前提（PM=NOM/WD=OFF）を壊すため **`FAULT.CFG_REJECT` で拒否**し反映しない。
- **反映タイミング**：書込値は `config.as5600_conf` に格納され、Core1 がループ先頭の `cfg_apply_pending()` で**全6chの AS5600 CONF(0x07/0x08) へ再書込**する（[software_architecture.md](software_architecture.md) §6.3 / §8.2）。反映は次巡以降。再書込直後の数サンプルは過渡となるため、上位は破棄して再取得すること（§6 のソース切替直後破棄と同様）。
- **⚠ RAW_ANGLE 使用時**：SF/FTH は RAW_ANGLE(0x0C/0x0D) には効かない可能性がある（[as5600_config.md](as5600_config.md) §3, 実機検証待ち）。既定の RAW 運用では本レジスタの効果が現れない場合がある。フィルタ効果を確認/利用するには `CONFIG`(0x40) bit0=1 で ANGLE 側へ切替える。
- **読み出し**は現在適用中の CONF ワードを返す（書込→読み戻しで反映を確認可能）。

### 4.9 `CH_PRESENT`（0x46, R）／`CH_ENABLE`（0x47, R/W）

接続ch数（1〜6ch）に応じた動作を司る中核レジスタ。全体挙動は **§11** に集約。各chは「present（実装検出）」と「enable（有効指定）」の直交2軸で状態が決まる。

**`CH_PRESENT`（0x46, R, 1byte）** — 自動検出結果（読み取り専用）

| bit | 意味 |
|-----|------|
| 0 | ch0 が起動プローブ/`RESCAN`で応答（AS5600実装あり） |
| 1 | ch1 同上 |
| 2 | ch2 同上 |
| 3 | ch3 同上 |
| 4 | ch4 同上 |
| 5 | ch5 同上 |
| 7:6 | 0 |

- 起動プローブ（§8.2 / [software_architecture.md](software_architecture.md) §8.1 手順3）および `CMD=RESCAN`（§7）で更新（ラッチ）。
- 上位はこれを読めば「物理的にどのchが挿さっているか」を確認できる。

**`CH_ENABLE`（0x47, R/W, 1byte）** — 有効ch選択マスク

| bit | 意味 |
|-----|------|
| 0 | ch0 を有効（巡回・DEGRADED判定の対象）にする |
| 1 | ch1 同上 |
| 2 | ch2 同上 |
| 3 | ch3 同上 |
| 4 | ch4 同上 |
| 5 | ch5 同上 |
| 7:6 | 0固定 |

- **リセット値＝起動時の `CH_PRESENT`（自動検出値）**。よって配線どおりに挿せば、上位設定なしで実装chのみが有効・残りは未使用となり、**1〜5ch構成でも `DEGRADED`/`ERR` は立たない**（§11.2）。
- 上位が明示上書きすることで「期待する構成」を宣言できる（§11.3）：
  - **有効かつ応答あり** → 正常（`CHn_OK=1`）。
  - **有効なのに無応答** → 故障として `STATUS_HI.DEGRADED` ＋ `CH_FAULT.CHn_COMM` をセット（本来在るべきchの抜線/故障を検出）。
  - **無効（bit=0）** → 未使用ch。巡回スキップ・`CHn_OK=0`固定・DEGRADED対象外。角度/AGCは無効マーカ（§5.4）。
- **反映**：`config.dirty` として次巡から Core1 が対象chを変更（他の設定レジスタと同様、[software_architecture.md](software_architecture.md) §8.2）。
- **拒否**：`0x00`（有効ch皆無）および bit7:6 が非0の書込は無効値として反映せず `FAULT.CFG_REJECT`。
- `CMD=RESCAN` は `CH_PRESENT` を更新するが `CH_ENABLE` は変更しない（上位の明示設定を保持）。新規検出chを使うには上位が `CH_PRESENT` を読み `CH_ENABLE` を再設定する。

### 4.10 `ZERO_CH_SELECT`（0x52, R/W）／`CHn_ZERO_OFFSET`（0x60–0x6B, R/W）

磁石の機械的な取付位置誤差を補正するための、ch毎0位置オフセット機構（[design_spec.md](design_spec.md) §5.5, 要件ID ZERO-01〜07）。EEPROMエミュレーション領域へ永続化される点は `identity`（§4.9とは別系統、[design_spec.md](design_spec.md) §5.4 USB-ID-03）と同じ運用方針を踏襲する。

**`ZERO_CH_SELECT`（0x52, R/W, 1byte）** — `CMD=ZERO_SET`/`CMD=ZERO_CLEAR`（§7.1）の適用対象chマスク

| bit | 意味 |
|-----|------|
| 0 | ch0 を対象にする |
| 1 | ch1 同上 |
| 2 | ch2 同上 |
| 3 | ch3 同上 |
| 4 | ch4 同上 |
| 5 | ch5 同上 |
| 7:6 | 0固定（非0の書込は`FAULT.CFG_REJECT`） |

- `CMD`書込前に対象chをここへ設定する（`DIR_CONFIG`/`CH_ENABLE`と同じ「設定レジスタ→CMD発行」の2段手順）。複数bitを立てて一括対象にできる。
- `0x00`（対象ch皆無）での`CMD=ZERO_SET`/`ZERO_CLEAR`発行は無効値として`FAULT.CFG_REJECT`。

**`CHn_ZERO_OFFSET`（0x60–0x6B, R/W, 2byte ×6ch, LE, 12bit）** — ch毎に適用中の0位置オフセット

- 読み出しは現在有効なオフセット値（EEPROMから復元済みの値、または最後に`ZERO_SET`で設定した値）を返す。
- 直接書込も許可する（製造時の一括プロビジョニング用）。書込値は0-4095の範囲外ビット（bit15:12）は無視し、即座に適用かつEEPROMへ保存する。他レジスタと異なり次巡反映ではなく即時反映とする（角度較正は次回サンプルから正しい値を返す必要があるため）。
- **保存タイミング**：`CMD=ZERO_SET`/`ZERO_CLEAR`実行時、および本レジスタへの直接書込時、対象chのオフセットをEEPROMエミュレーション領域へ都度書き込む。フラッシュ書込回数を抑えるため、同一値への再書込（無変化）はスキップしてよい。

**`CMD=ZERO_SET`（0x50=0x10, §7.1）** — 0位置設定（現在位置を0degにする）

1. `ZERO_CH_SELECT`で対象chビットマスクを設定する。
2. `CMD`へ`0x10`（`ZERO_SET`）を書き込む。
3. Core1が対象chそれぞれについて、直近サンプル済みの`raw_angle`をそのまま新たな`CHn_ZERO_OFFSET`として採用し、EEPROMへ保存する（busy完了）。
4. 対象chが**無効（`CH_ENABLE`該当bit=0）または無応答（`STATUS_LO.CHn_OK`=0）**の場合、そのchはオフセットを変更せず処理をスキップし、コマンド全体を失敗として扱う（`FAULT.CFG_REJECT`、`CMD`読み値は`0xFF`）。一部chのみ失敗した場合も、成功したchのオフセットはロールバックしない（部分適用）。
5. 実行直後の数サンプルは過渡（オフセット切替直後）となるため、上位は破棄して再取得すること（§4.6 DIR切替時と同様の運用）。

**`CMD=ZERO_CLEAR`（0x50=0x11, §7.1）** — 0位置クリア（較正を無効化しRAW_ANGLEそのままへ戻す）

- `ZERO_CH_SELECT`で指定した対象chの`CHn_ZERO_OFFSET`を`0`にリセットし、EEPROMへ保存する。
- 対象ch選択・busy完了・部分失敗時の扱いは`ZERO_SET`と同様。無効ch/無応答chでもクリア自体は許可する（既定値へ戻すだけのため、原則失敗しない）。

---

## 5. 角度データ形式

### 5.1 バイトレイアウト（LE, 12bit）

各 `CHn_ANGLE`（2バイト）：

```
byte0 (下位) = angle[7:0]
byte1 (上位) = { 0000, angle[11:8] }   ← 上位4bitは0
```

復元：
```c
uint16_t angle = (d1 << 8) | d0;   // または  d0 | (d1 << 8)
angle &= 0x0FFF;                    // 12bit マスク（上位nibbleは常に0だが安全のため）
```

例：`raw = 0x0ABC (2748)` → バス上は `d0=0xBC, d1=0x0A`。

### 5.2 スケーリング

- 値域 0–4095（12bit）が機械角 0–360°（既定 RAW_ANGLE, 未加工生位置）に対応。
- **角度範囲・単位変換・方向正規化は上位で実施**（ブリッジは生位置を転送）。DIRによる増加方向は §4.6。
- `deg = raw * 360.0 / 4096.0`。
- **例外（磁石取付誤差の較正のみ）**：`CHn_ANGLE`（本節, ホットパス出力）は下流生値そのものではなく、ch毎の `CHn_ZERO_OFFSET`（§4.10）を差し引いた相対値を返す。`CHn_ANGLE = (raw_angle − zero_offset[ch] + 4096) mod 4096`。既定オフセット=0では従来どおり生値と一致する（後方互換）。オフセット適用前の生値そのものが必要な場合は、USBシリアル`ch read`（[usb_serial_spec.md](usb_serial_spec.md) §6.1）でAS5600のRAW_ANGLE(0x0C/0x0D)へ直接アクセスすること。

### 5.3 スナップショットミラー（0x1C / 0x1D / 0x1E）

`STATUS_LO_M`(0x1C)・`STATUS_HI_M`(0x1D)・`SAMPLE_LO`(0x1E) は、それぞれ `STATUS_LO`(0x02)・`STATUS_HI`(0x03)・`SAMPLE_COUNT` 下位バイトの複製。角度ブロック(0x10-0x1B)直後に連続配置することで、15バイト単一バースト（§3.1）で**角度＋健全性＋鮮度を同一スナップショットとして**取得できる。全レジスタはトランザクション開始時に一括ラッチされるため、ミラーと本体の値は必ず整合する。

### 5.4 無効ch（未使用）の角度・AGCマーカ

`CH_ENABLE`（§4.9）で**無効**のch（未実装／未使用）は、故障ch（旧値保持）と区別できる無効マーカを返す：

| レジスタ | 無効chの値 | 判別根拠 |
|---------|-----------|---------|
| `CHn_ANGLE` | `0xFFFF`（バス上 `d0=0xFF, d1=0xFF`） | 有効角度は上位nibbleが常に0（上位バイト`0x0X`）なので、上位バイト`0xFF`で無効と判別可能（§5.1） |
| `CHn_AGC` | `0xFF` | 故障ch（有効かつ無応答）は`0x00`、無効chは`0xFF`で区別 |
| `STATUS_LO.CHn_OK` | `0` | 無効・故障とも0。両者は `CH_ENABLE` ビットで判別 |

- ホットパス（§3.1 の12/15バイト読み）でも無効chの角度スロットは `0xFFFF` になる。上位は `CH_ENABLE` に基づき該当スロットを読み捨てる（§11.5）。
- **故障ch（有効なのに無応答）**は従来どおり**旧値保持・AGC=0**（§4.1）で、無効マーカとは値が異なる。

---

## 6. 未定義／不正アクセスの挙動（ホスト視点）

| ケース | ブリッジの挙動 | 上位の対処 |
|--------|--------------|-----------|
| 範囲外オフセットを読む | 0xFF を返す（エラーにしない）。`FAULT.PTR_RANGE`セット | 0xFF を無効として扱う |
| R領域／未定義へ書く | 無視。`STATUS_HI.ERR` + `FAULT.CFG_REJECT`セット | STATUS確認、書込値を見直す |
| 無効な設定値を書く | 反映せず `FAULT.CFG_REJECT`セット | 値域を確認（本書§4） |
| ch無応答（有効chの故障） | 該当ch旧値保持・`AGC=0`・`STATUS_LO.CHn_OK=0`・`STATUS_HI.DEGRADED`＋`CH_FAULT.CHn_COMM` | 当該ch値を無効扱い、必要なら`CMD`で再スキャン |
| ch無効（未使用, `CH_ENABLE`=0） | 巡回スキップ。角度`0xFFFF`・`AGC=0xFF`・`CHn_OK=0`・DEGRADED対象外（§4.9/§5.4/§11） | `CH_ENABLE`で無効を確認し当該chを読み捨て |
| 下流バス固着 | ブリッジが自動復旧、`FAULT.BUS_RECOVER`セット | 通常は自動回復。継続時は`CMD=MUX_RESET` |
| 上流バス固着 | スレーブは能動復旧不可。WDTで自己回復（[i2c_architecture.md](i2c_architecture.md) §8） | **マスタ（上位）の責務**でバス復旧（STOP発行等） |

---

## 7. コマンドレジスタ `CMD`（0x50）

割込み通知線を持たない（[i2c_architecture.md](i2c_architecture.md) §7）ため、非データ系の操作は本レジスタで発行し、**完了は `CMD` 読み値または `STATUS`/`SAMPLE_COUNT` のポーリングで確認**する。

### 7.1 書き込み（コマンド発行）

| 値 | 名称 | 動作 | 完了種別 |
|----|------|------|---------|
| 0x00 | `NOP` | 何もしない | 即時 |
| 0x01 | `CLEAR_FAULT` | `FAULT`/`CH_FAULT` 全ビットと `STATUS_HI.ERR` をクリア | 即時 |
| 0x02 | `MUX_RESET` | TCA9548A を RESET パルス→再初期化 | busy（下流処理） |
| 0x03 | `RESCAN` | 下流プローブ再実行（mux/各AS5600応答確認） | busy（下流処理） |
| 0x10 | `ZERO_SET` | `ZERO_CH_SELECT`で指定したchの現在位置を新たな0位置オフセットとして設定・EEPROM保存（§4.10） | busy（EEPROM書込） |
| 0x11 | `ZERO_CLEAR` | `ZERO_CH_SELECT`で指定したchの0位置オフセットを0へリセット・EEPROM保存（§4.10） | busy（EEPROM書込） |
| 0xA5 | `SOFT_RESET` | FWをWDT経由で再起動（角度は再取得。数十ms応答断） | 応答断→再起動 |

- **完了種別「即時」**：発行後ただちに完了。`CMD` 読み値は即 idle(0x00)/失敗(0xFF)。
- **完了種別「busy（下流処理）」**：下流I2Cを要するため Core1 が巡回の合間に実行する（FW内部機構は [software_architecture.md](software_architecture.md) §7.1）。実行中 `CMD` 読みは 0x01(busy)。上位は idle になるまでポーリングする。
- **busy 中の新規コマンド発行は拒否**：`CMD` が busy(0x01) の間に別コマンドを書くと**無視し `FAULT.CFG_REJECT`** をセット（実行中コマンドは継続）。上位は idle を確認してから次コマンドを発行すること（キューは持たない・深さ0）。
- 未定義コマンドは無視し `FAULT.CFG_REJECT`。
- `SOFT_RESET` 実行中はスレーブが一時的に応答しない（NACK）。上位はリトライ想定。
- `RESCAN` は下流プローブを再実行して `CH_PRESENT`(0x46) を更新する（`CH_ENABLE` は変更しない, §4.9）。抜線→再接続の検出や実装ch数の再確認に用いる。

### 7.2 読み出し（実行結果／ビジー）

| 値 | 意味 |
|----|------|
| 0x00 | idle / 前回コマンド完了（OK） |
| 0x01 | busy（実行中。完了までポーリング） |
| 0xFF | 前回コマンド失敗（`FAULT`参照） |

> コマンドは即時完了するものが多く、通常は発行後 `STATUS`/`FAULT` を読めば足りる。長め（`RESCAN`/`MUX_RESET`）のものは `CMD` を idle になるまでポーリングする。

---

## 8. 代表シーケンス（バイトレベル）

`W=0x84`(=0x42<<1|0), `R=0x85`(=0x42<<1|1)。

### 8.1 6ch角度一括取得（最頻ユースケース, 15バイト推奨）

```
S 84 A  10 A  Sr 85 A  [a0L a0H a1L a1H a2L a2H a3L a3H a4L a4H a5L a5H slo shi scnt] N P
        └ptr=0x10        └ ch0 .. ch5(12B)                              STATUS_LO_M STATUS_HI_M SAMPLE_LO
```
擬似コード（1kHz周期で反復）：
```c
uint8_t buf[15];
i2c_read_reg(0x42, 0x10, buf, 15);          // §2.2 コンバインド
uint8_t status_lo = buf[12];
if ((status_lo & 0x3F) == 0x3F) { /* 全ch OK */ }
uint16_t ch[6];
for (int i=0;i<6;i++) ch[i] = (buf[2*i] | (buf[2*i+1]<<8)) & 0x0FFF;
if (buf[14] != last_sample) { /* 新データ */ last_sample = buf[14]; }
```

### 8.2 起動時の疎通確認

**起動契約（確定）**：ブリッジは上流スレーブ(0x42)を**下流プローブ・AS5600初期設定の完了後**に有効化する（**遅延有効化**, [software_architecture.md](software_architecture.md) §8.1 手順6）。したがって：

- 完全 ready まで 0x42 は**応答しない（NACK）**。
- **0x42 が ACK し `WHO_AM_I=0xB6` を返した時点で、全レジスタが有効値でありデータも整合**している（角度・STATUS が確定済み）。中途半端な状態が上位に見えることはない。
- ready 到達は**電源投入後 ≤100ms**（AS5600 の T_PU 10ms＋下流プローブ＋CONF書込＋バッファ初期化を含む目標上限, §1.1）。

```
# 手順0（必須）: power-on 後、WHO_AM_I をポーリングして ready を待つ
loop (interval 10ms, timeout 200ms):        # timeout = ready上限×2 の余裕
    r = read 0x00 (WHO_AM_I)                 # NACK/不正値は「未ready」として継続
    if r == 0xB6: break
else: fail                                    # 200ms 超過はエラー扱い（配線/電源/FW確認）

# 手順1以降: ready 確認後の初期化
read 0x01 (VERSION)  → FW版を記録
read 0x02 (STATUS_LO) → bit0-5 が 1 (全ch OK) を確認
read 0x03 (STATUS_HI) → ERR/DEGRADED を確認
read 0x04 (FAULT)    → 0x00 を確認（WDT_RESET等が無いか。WDT_RESET=1 なら前回異常）
```

> `SOFT_RESET`(§7.1) 後の再 ready 待ちも同じポーリングを用いる（応答断からの復帰確認）。

### 8.3 回転方向の設定（例：ch1のみCCW増加, 即時反映）

```
S 84 A  42 A  82 A  P     ← ptr=0x42(DIR_CONFIG), data=0x82 (bit1=1, bit7=APPLY_NOW)
```
> 反映直後の数サンプルは破棄して再取得（§4.6）。

### 8.4 角度ソースをフィルタ後ANGLEへ切替

```
S 84 A  40 A  01 A  P     ← ptr=0x40(CONFIG), data=0x01 (ANGLE_SRC=1)
```

### 8.5 エラークリア／mux復旧

```
S 84 A  50 A  01 A  P     ← CMD=CLEAR_FAULT
...
S 84 A  50 A  02 A  P     ← CMD=MUX_RESET
（その後 CMD(0x50) を idle(0x00) になるまでポーリング）
```

### 8.6 1〜5ch構成での初期化（例：ch0-2のみ実装）

```
# 手順0-1: §8.2 と同じ（WHO_AM_I ready 待ち → VERSION 取得）
read 0x46 (CH_PRESENT) → 0x07 を確認（ch0-2のみ検出）
# 期待どおりなら CH_ENABLE は既定(=0x07)のままで追加設定不要。
# 「ch0-2が必ず在る」ことを保証させたい場合のみ明示宣言（抜けたらDEGRADED）：
S 84 A  47 A  07 A  P     ← CH_ENABLE=0x07（ch0-2のみ有効・期待）
read 0x02 (STATUS_LO) → bit0-2=1(ch0-2 OK) を確認
read 0x03 (STATUS_HI) → bit0(DEGRADED)=0 を確認

# 角度取得：ch3-5スロットは 0xFFFF（無効マーカ, §5.4）→ 上位は読み捨て
S 84 A  10 A  Sr 85 A  [a0L a0H a1L a1H a2L a2H FF FF FF FF FF FF slo shi scnt] N P
```
> 上位の健全性判定は6ch固定でなく `CH_ENABLE` でマスクすること（§11.5）。

---

### 8.7 0位置設定（例：ch1を現在位置で0degにする）

```
S 84 A  52 A  02 A  P     ← ptr=0x52(ZERO_CH_SELECT), data=0x02 (bit1=ch1のみ対象)
S 84 A  50 A  10 A  P     ← CMD=ZERO_SET
（その後 CMD(0x50) を idle(0x00) になるまでポーリング。0xFFなら失敗＝ch1が無効/無応答）
S 84 A  62 A  Sr 85 A [o0L o0H] N P   ← ptr=0x62(CH1_ZERO_OFFSET) を読み戻し、設定値を確認
```

較正をやめて生値へ戻す場合：

```
S 84 A  52 A  02 A  P     ← ZERO_CH_SELECT=0x02（ch1）
S 84 A  50 A  11 A  P     ← CMD=ZERO_CLEAR
```

---

## 9. バージョニング・互換性

- `WHO_AM_I`(0xB6) と `VERSION` で上位はデバイス種別／世代を判別。
- レジスタマップは**追加は予約領域(reserved)へ**行い、既存オフセット・意味は変更しない（後方互換）。
- 非互換変更が必要な場合は `VERSION` の major を上げる。上位は起動時に major を検証すること。

### 9.1 `VERSION`(0x01) エンコード（確定）

1バイトを nibble 分割する：

```
VERSION = (major << 4) | minor
  major = (VERSION >> 4) & 0x0F   // 0–15：非互換世代。変わると後方互換なし
  minor =  VERSION       & 0x0F   // 0–15：後方互換の範囲での機能追加/修正
```

- **3ch初版FW = `0x01`**（major=0 / minor=1）。**6ch初版FW = `0x10`**（major=1 / minor=0, レジスタマップ再配置に対応）。**0位置対応6ch版FW = `0x11`**（major=1 / minor=1, 後方互換の追加）。表記は `v<major>.<minor>`。
- **major を上げる契機**：既存オフセットの意味変更・削除、レジスタ再配置、トランザクション形式変更など**後方互換を壊す変更**。予約領域へのレジスタ追加のみなら minor を上げる。

### 9.2 上位（controller）の互換性チェック（確定）

起動時（§8.2 手順1で `VERSION` 取得後）に **major 一致を要求**する：

```c
uint8_t v = read_reg(0x01);
if ((v >> 4) != EXPECTED_MAJOR)   // 非互換 → 停止
    fatal("bridge FW major mismatch: got %u, need %u", v>>4, EXPECTED_MAJOR);
if ((v & 0x0F) != EXPECTED_MINOR) // minor 差異 → 警告のみで継続（後方互換）
    log_warn("bridge FW minor differs: v%u.%u", v>>4, v&0x0F);
```

- **major 不一致は致命**（レジスタ意味が変わっている可能性 → 続行しない）。3ch版(major=0)と6ch版(major=1)は非互換のため、旧ドライバは必ず起動時に停止する。
- **minor 差異は許容**（後方互換。新しい minor の追加レジスタを使わなければ動作する）。controller が特定 minor 以上の機能に依存する場合のみ、必要に応じ最小 minor を追加検証してよい。

---

## 10. 確定事項 / 要確認

### 本書で確定（既存決定に整合）
- [x] レジスタマップ全オフセット確定（§3, 6ch/v1.0）。`STATUS`を2バイト(LO/HI)化、`FAULT`と`CH_FAULT`を分離、角度/AGCブロックをch3-5分拡張。
- [x] SF/FTH 実行時変更手段＝`AS5600_CONF`(0x44) レジスタで確定（§4.8）。SF/FTHのみ変更可、Core1が全chへCONF再書込。
- [x] 高速読み出しブロック：12バイト(正準)／15バイト(推奨)（§3.1）。
- [x] `CMD` コマンドセット定義（§7, 割込み線なしを前提としたポーリング完了確認）。
- [x] `POLL_PERIOD=0` を全力巡回（既定）と定義し [i2c_architecture.md](i2c_architecture.md) の決定に整合（§4.5）。
- [x] 起動契約：上流スレーブ(0x42)は**遅延有効化**（下流プローブ・CONF書込完了後）。**電源投入後 ≤100ms** で応答開始、応答＝データ有効（§8.2）。
- [x] `CONFIG.bit0` の数値表現と FW `config.angle_src` の整合（**0=RAW/1=ANGLE で統一・既定 RAW_ANGLE**。§4.4）。
- [x] `VERSION` エンコード＝**4bit major / 4bit minor** で確定。3ch初版=`0x01`、6ch初版=`0x10`、0位置対応6ch版=`0x11`。上位は**major一致を要求**（minor差異は警告のみ継続, §9.1/§9.2）。
- [x] 接続ch数（1〜6ch）対応（§4.9/§5.4/§11）：**起動時自動検出（`CH_PRESENT` 0x46）＋上位上書き（`CH_ENABLE` 0x47）**の二層で確定。無効chは巡回スキップ・角度`0xFFFF`/AGC`0xFF`・DEGRADED対象外。**有効なのに無応答は故障（DEGRADED＋`CH_FAULT.CHn_COMM`）**。既定`CH_ENABLE`＝起動検出値で、配線どおりなら無設定で正常起動。
- [x] 0位置設定（§4.10）：`ZERO_CH_SELECT`(0x52)/`CHn_ZERO_OFFSET`(0x60–0x6B)/`CMD=ZERO_SET(0x10)`/`CMD=ZERO_CLEAR(0x11)`で確定。`CHn_ANGLE`へのオフセット適用式・EEPROM永続化・既定オフセット0での後方互換を規定（[design_spec.md](design_spec.md) §5.5）。

### 実装前に要確認（☐）
- [ ] `CMD` 各コマンドの実処理時間（`RESCAN`/`MUX_RESET` の busy 継続時間の実測）。
- [ ] 上位実機（Linux i2c-dev 等）での 0x42 応答・15バイト一括リード疎通（[i2c_architecture.md](i2c_architecture.md) §11.5）。
- [ ] 起動時 **全ch無応答（0ch検出）** でも 0x42 を有効化し STATUS で通知する方針の是非（§11.4）。上流readyの下限扱いを実機で確定。
- [ ] ファームウェアの6ch対応実装（現行FWは`kChannelCount=3`のまま。本書のレジスタオフセットへの追従が必要）。
- [x] 0位置設定（§4.10）のArduino版ファームウェア実装：基板ID直後の独立したmagic/checksum付きEEPROM領域へ格納し、同一値はEEPROMライブラリ側で書込省略。`ZERO_SET`はCore1実行時の最新publish済みRAW_ANGLEを採用（2026-08-01）。

---

## 11. 接続ch数に応じた動作（1〜5ch 構成）

AS5600 が6ch未満（1〜5ch）しか接続されない構成での動作を規定する。中核は `CH_PRESENT`(0x46, 自動検出) と `CH_ENABLE`(0x47, 有効マスク)（§4.9）。

### 11.1 チャネルの状態モデル

各chは直交する2軸で状態が決まる：

- **present（実装検出）**：起動プローブ/`RESCAN`で AS5600 が応答したか（`CH_PRESENT`）。
- **enable（有効指定）**：巡回・健全性判定の対象か（`CH_ENABLE`）。既定＝起動時 present。

| enable | 応答 | 分類 | `CHn_OK` | 角度 / AGC | DEGRADED |
|--------|------|------|----------|-----------|----------|
| 1 | あり | 正常 | 1 | 実測値 / 実測 | 寄与しない |
| 1 | なし | **故障**（抜線/不良） | 0 | 旧値保持 / `0x00` | **寄与**＋`CH_FAULT.CHn_COMM` |
| 0 | — | 未使用 | 0 | `0xFFFF` / `0xFF` | 寄与しない |

### 11.2 既定動作（自動検出・上位設定不要）

- 起動プローブで応答したchのみ present とし、`CH_ENABLE` の初期値に採用する。→ **1〜5ch構成でも、配線どおりに挿すだけで当該chが有効・残りは未使用となり、`DEGRADED`/`ERR` は立たない**（正常起動）。
- 上位は `CH_PRESENT`/`CH_ENABLE` を読めば実装ch数を確認できる。設定不要で「挿さっているだけ動く」プラグ＆プレイ。

### 11.3 明示上書き（期待構成の宣言・故障検出）

- 「この構成では必ず ch0/ch1 が在るべき」等を保証したい場合、上位が `CH_ENABLE` に期待ビットを書く。
- 有効指定したchが（起動時 or 運用中に）無応答なら故障として `STATUS_HI.DEGRADED` ＋ `CH_FAULT.CHn_COMM` を上げる。これで「本来在るべきchの抜線/故障」を検出できる（自動検出のみでは未実装と区別できないため）。
- 逆に、実装済みでも使いたくないchは `CH_ENABLE` の bit を落とせば巡回スキップ・DEGRADED対象外にできる。

### 11.4 巡回・タイミングへの影響

- Core1 は **有効ch のみ**を巡回（mux選択）する。無効chは mux選択もアクセスも行わない（[software_architecture.md](software_architecture.md) §8.2）。
- `SAMPLE_COUNT`(0x08) は**有効chを1巡し publish するごとに +1**。
- 有効ch数が少ないほど巡回時間は短縮し、実効サンプルレートが上がる（6ch巡回の律速が緩和, [i2c_architecture.md](i2c_architecture.md) §5.5.3）。上位の読み出し周期(1kHz)や12/15バイト一括読みの形式は不変（無効chスロットは `0xFFFF`）。
- **全ch無効（有効ch皆無）は許容しない**（§4.9 で `CFG_REJECT`）。起動時に全ch無応答だった場合でも 0x42 は有効化し、`CH_PRESENT=0x00`・全 `CHn_OK=0`・`DEGRADED` で上位へ通知する（配線/電源診断のため。ready契約 §8.2 は維持）。**← 方針は要確認（§10）**。

### 11.5 上位（controller）側の扱い

- 健全性判定は6ch固定ではなく `CH_ENABLE` でマスクする。例：
  ```c
  uint8_t en = read_reg(0x47) & 0x3F;          // 有効chマスク
  uint8_t ok = read_reg(0x02) & 0x3F;          // STATUS_LO bit0-5
  if ((ok & en) == en) { /* 全有効chOK */ }
  if (read_reg(0x03) & 0x01) { /* DEGRADED: 有効chに異常 */ }
  ```
- 角度は `CH_ENABLE` の有効bitのchのみ採用。無効chスロット（`0xFFFF`）は読み捨てる（§5.4）。
- 実装ch数が固定の製品では、起動時に `CH_PRESENT` を期待値と照合し、不一致なら構成エラーとして扱うとよい（§11.3 の `CH_ENABLE` 明示宣言と併用）。
