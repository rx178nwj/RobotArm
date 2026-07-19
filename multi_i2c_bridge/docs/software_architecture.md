# ブリッジマイコン ソフトウェアアーキテクチャ設計

RP2040ブリッジ ファームウェアの構造検討

| 項目 | 内容 |
|------|------|
| 対象 | RP2040 ブリッジファームウェア |
| 関連 | [design_spec.md](design_spec.md) / [i2c_architecture.md](i2c_architecture.md) |
| 版 | 0.2（3ch初版→6ch実装に追従） |
| 作成日 | 2026-07-10（初版）／2026-07-19 改訂（6ch化） |

---

## 1. 目的・スコープ

上位から見た「1個のI2Cセンサ（0x42）」として、AS5600×6ch の角度を集約提供するRP2040ファームウェアの内部構造を定義する。

前提（確定事項）：
- 上流・下流とも **400kHz**、上位は **6ch・1kHz** で一括読み出し
- **デュアルコア分離**：Core0=上流応答 / Core1=下流ポーリング
- データ整合性は **ダブルバッファ + トランザクション開始時スナップショット**

---

## 2. 設計原則

| 原則 | 内容 |
|------|------|
| ベアメタル（RTOSなし） | 2コアが2役割に自然対応。RTOSのスケジューラ遅延・複雑さを排し決定性を確保 |
| 単方向データフロー | センサ値=Core1→Core0（高頻度）、設定=Core0→Core1（低頻度）に限定し競合面を最小化 |
| 同期境界の局所化 | コア間共有は `sensor_data` と `config` の2モジュールに閉じ込める |
| ドライバ/アプリ分離 | HAL（pico-sdk）→デバイスドライバ→アプリ層の三層。ハード依存を下層に隔離 |
| 非ブロッキング上流 | 上流ISRは下流通信の完了を待たない（キャッシュ即応答） |
| 自己回復 | WDT＋バス復旧で異常から自律復帰 |

---

## 3. レイヤ構成

```
┌───────────────────────────────────────────────────────┐
│ アプリ層                                                │
│   main / sampler(Core1) / upstream_service(Core0)       │
├───────────────────────────────────────────────────────┤
│ ドメイン層（コア間同期境界）                            │
│   bridge_regs（レジスタマップ）  sensor_data（2重ﾊﾞｯﾌｧ） │
│   sys_status（状態集約）         config（実行時設定）    │
├───────────────────────────────────────────────────────┤
│ デバイスドライバ層                                      │
│   as5600   tca9548a   fault/bus_recovery                │
├───────────────────────────────────────────────────────┤
│ HAL / BSP 層                                            │
│   pico-sdk (i2c_slave, i2c master, multicore, watchdog) │
│   board.h（ピン定義・I2Cインスタンス割付）              │
└───────────────────────────────────────────────────────┘
```

---

## 4. モジュール分割

| モジュール | コア | 責務 | 主API（例） |
|-----------|------|------|------------|
| `main` | Core0 | クロック/周辺初期化、下流プローブ、Core1起動、上流サービス起動 | `main()` |
| `upstream_i2c` | Core0 | I2C0スレーブ設定とISR。イベント→`bridge_regs`へ委譲 | `upstream_init()`, ISRハンドラ |
| `bridge_regs` | Core0 | レジスタマップ定義、ポインタ管理、読出時スナップショット生成、書込適用 | `regs_on_write()`, `regs_on_read_byte()`, `regs_snapshot()` |
| `sampler` | Core1 | 下流ポーリング状態機械。mux切替＋AS5600読出→shadow→publish | `sampler_run()` |
| `downstream_i2c` | Core1 | I2C1マスタのブロッキング/タイムアウト付きヘルパ | `ds_write()`, `ds_read()` |
| `tca9548a` | Core1 | muxチャネル選択・リセット | `mux_select(ch)`, `mux_reset()` |
| `as5600` | Core1 | 角度/STATUS/AGC/CONF読み書き | `as5600_read_angle()`, `as5600_config()` |
| `sensor_data` | 共有 | ダブルバッファ、publish/snapshot、原子的index交換 | `sd_publish()`, `sd_snapshot()` |
| `config` | 共有 | 実行時設定（RAW/フィルタ選択、間引き率等）、変更通知 | `cfg_get()`, `cfg_set()` |
| `sys_status` | 共有 | 磁石検出・通信エラー・鮮度フラグの集約 | `status_update()`, `status_read()` |
| `fault` | 両 | WDT給餌、下流バス復旧、muxリセット判断 | `wdt_task()`, `bus_recover()` |
| `usb_console` | Core0 | USB-CDCライン組立・コマンドパース・応答送出（ISR外, [usb_serial_spec.md](usb_serial_spec.md)） | `console_poll()` |
| `diag_mailbox` | 共有 | `ch read`/`ch write`等の診断コマンドをCore1へ依頼するロックフリーメールボックス | `diag_request()`, `diag_poll_result()` |
| `status_led` | Core0 | ステータスLED4灯（Red/Yellow/Blue/WS2812）の非ブロッキング駆動（[design_spec.md](design_spec.md) §10） | `status_led_poll()` |
| `board.h` | — | ピン・I2Cインスタンス・アドレス定数 | 定数のみ |

---

## 5. 実行モデル（デュアルコア）

```
 Core0（上流・受動・割込駆動）              Core1（下流・能動・周期）
 ─────────────────────────────            ─────────────────────────────
 main():                                   sampler_run():
   init clocks / board                       loop {
   upstream_init(I2C0,0x42)                     for ch in 0..5 {
   downstream probe (一時的にCore0で実施)          mux_select(ch)
   multicore_launch_core1(sampler_run)            a = as5600_read_angle(ch)
   loop {                                          shadow.angle[ch] = a
     __wfe();          // ISR待機               if (decimate) 読STATUS/AGC
     fault_wdt_task(); // 生存監視+給餌         }
   }                                             shadow.sample_count++
                                                 sd_publish(&shadow)   // swap
 [I2C0 Slave ISR]                                cfg_apply_pending()
   RECEIVE → regs_on_write()                     fault_kick_core1()
   REQUEST → regs_on_read_byte()               }
   FINISH  → regs_on_finish()
```

- **スケジューリング**：Core0はISR駆動＋WFEアイドル。Core1は自由走行ループ（全力巡回≒900-980Hz、[i2c_architecture.md](i2c_architecture.md) §5.5）。
- **優先度**：上流ISRはCore0専有のため下流処理に一切ブロックされない。

---

## 6. データモデル

### 6.1 センサスナップショット & ダブルバッファ

```c
typedef struct {
    uint16_t angle[6];      // 12bit (0..4095)。無効ch(未使用)は0xFFFF（[command_spec.md](command_spec.md) §5.4）
    uint8_t  agc[6];        // 磁石距離目安。無効chは0xFF
    uint8_t  ch_ok;         // bit0..5: 各ch磁石検出/通信OK。無効ch・故障chとも0
    uint32_t sample_count;  // publish毎に++（上位が新旧判別）
} sensor_snapshot_t;

static sensor_snapshot_t g_buf[2];
static volatile uint32_t g_active;   // 0/1、32bitアライン=原子的
```

- **Core1（書き手）**：`shadow = g_buf[g_active ^ 1]` に全ch書込 → メモリバリア → `g_active ^= 1`（publish）。部分更新は絶対にpublishしない。
- **Core0（読み手）**：読み出しトランザクション開始時に `idx=g_active` を採取し `memcpy` で `tx_staging` へ確定。以降のバーストは `tx_staging` から供給し、途中swapの影響を受けない。

### 6.2 レジスタマップ実体化

`bridge_regs` は論理マップ（[design_spec.md](design_spec.md) §5.2）を、読出開始時に `tx_staging[]`（〜0x40B）へ次のように材料化する：

```
read開始 → sd_snapshot(&snap) → tx_staging に
   0x02..0x03 STATUS_LO/HI ← sys_status（DEGRADED は有効ch=config.ch_enable のみで判定）
   0x10..0x1B ANGLE  ← snap.angle[0..5] (LE)（無効ch=0xFFFF）
   0x30..0x35 AGC    ← snap.agc[0..5]（無効ch=0xFF）
   0x46 CH_PRESENT   ← g_ch_present
   0x47 CH_ENABLE    ← config.ch_enable
   ...
以降 regs_on_read_byte() は tx_staging[ptr++] を返す
```

### 6.3 実行時設定

```c
typedef struct {
    uint8_t  angle_src;     // 0=RAW_ANGLE(0x0C)（既定）/ 1=ANGLE(0x0E)。CONFIG(0x40)bit0と同一表現（[command_spec.md](command_spec.md) §4.4）
    uint8_t  status_decim;  // STATUS/AGC間引き率（巡回n回に1回、既定~18=100Hz相当）
    uint16_t as5600_conf;   // 既定=0x0A00（SF=4x, FTH=7LSB, PM=NOM, WD=OFF）。上位はAS5600_CONF(0x44/0x45, LE)で SF/FTH のみ変更可（[command_spec.md](command_spec.md) §4.8）
    uint8_t  dir_config;    // 各ch回転方向 bit0-5（0=L:CW増加/1=H:CCW増加）。既定=0x00。DIR GPIO(GP5-10)へ反映（[design_spec.md](design_spec.md) §6.4 / レジスタ0x42）
    uint8_t  ch_enable;     // bit0-5: 有効ch(巡回・DEGRADED対象)。既定=起動プローブ検出値(ch_present)。CH_ENABLE(0x47)（[command_spec.md](command_spec.md) §4.9）
} bridge_config_t;

// 起動プローブ/RESCAN で確定する実装検出結果（読み取り専用公開: CH_PRESENT 0x46）
static uint8_t g_ch_present;   // bit0-5: プローブで応答したch

> `dir_config` は上位からレジスタ 0x42（DIR_CONFIG）で設定される静的な方向選択。Core0が書込を受けて `config` に反映し、Core1がループ先頭の `cfg_apply_pending()` で各chの DIR GPIO を駆動する（AS5600内部レジスタではなくハード入力ピン）。方向反転は出力に不連続を生じるため、切替直後サンプルは上位が破棄する（[design_spec.md](design_spec.md) §6.4）。

> `ch_enable` は接続ch数（1〜6ch）対応の中核（[command_spec.md](command_spec.md) §4.9/§11）。起動プローブ（§8.1 手順3）で `g_ch_present` を確定し、`config.ch_enable` の初期値に採用する（＝配線どおりに挿せば実装chのみ有効・無設定で正常起動）。上位が `CH_ENABLE`(0x47) を書くと Core0 が `config.ch_enable` へ反映（`dirty`）し、Core1 は**有効chのみを巡回**（無効chは mux選択もアクセスもせず、`angle=0xFFFF`/`agc=0xFF`/`ch_ok`該当bit=0）。DEGRADED は有効chのみで判定。`0x00`(有効ch皆無) と bit7:6 非0 は `CFG_REJECT`。`RESCAN` は `g_ch_present` を更新するが `config.ch_enable` は変更しない。

> AS5600設定の確定値・根拠は [as5600_config.md](as5600_config.md)。起動時に各chへ `CONF=0x0A00` を揮発書込。実行時に上位が `AS5600_CONF`(0x44/0x45) を書くと Core0 が `config.as5600_conf` へ反映（`dirty`）し、Core1 がループ先頭の `cfg_apply_pending()` で**全6chの AS5600 CONF(0x07/0x08) へ再書込**する。SF/FTH 以外の変更は拒否（`FAULT.CFG_REJECT`）。再書込直後の数サンプルは過渡（[command_spec.md](command_spec.md) §4.8）。

---

## 7. コア間通信・同期

| 方向 | データ | 頻度 | 機構 |
|------|--------|------|------|
| Core1→Core0 | センサ値 | 高（~1.8kHz） | ダブルバッファ＋原子的index（ロックフリー） |
| Core0→Core1 | 設定変更 | 低（稀） | 共有`config`＋`dirty`フラグ。Core1がループ先頭で取り込み |

- 設定は複数フィールドの一貫性が要る場合のみ **HWスピンロック**（`spin_lock`）で保護。単一ワード更新は原子的で足りる。
- 非データ系コマンド（`CMD`）の Core0→Core1 依頼は **コマンドメールボックス**（§7.1）で仲介する。
- **原則ロックフリー**。高頻度経路（センサ値）にロックを置かない。

### 7.1 コマンド機構（`CMD` レジスタのコア間ディスパッチ）

`CMD`(0x50) は Core0 の上流ISRが受けるが、下流I/Oを伴うコマンド（`MUX_RESET`/`RESCAN`）の実処理は Core1 が行う。両者を **ロックフリーのコマンドメールボックス**（単一生産者=Core0 / 単一消費者=Core1）で仲介する。

```c
typedef struct {
    volatile uint8_t  req_cmd;   // Core0のみ書込：コマンドopcode
    volatile uint32_t req_seq;   // Core0のみ書込：新規受理ごとに ++
    volatile uint32_t ack_seq;   // Core1のみ書込：実行完了時に req_seq を複写
    volatile uint8_t  result;    // Core1のみ書込：0x00=OK / 0xFF=FAIL（ack_seq==req_seq 時に有効）
} cmd_mailbox_t;
// busy 判定： (req_seq != ack_seq)
```

**分類と実行主体**：

| コマンド | 実行主体 | 機構 |
|----------|---------|------|
| `NOP` / `CLEAR_FAULT` | Core0（即時） | ISR内で完結。CLEAR_FAULT は FAULT/STATUS.ERR を原子的クリア。メールボックス不使用（busyにしない） |
| `MUX_RESET` / `RESCAN` | Core1（下流I/O） | メールボックス経由（下記フロー） |
| `SOFT_RESET` | どちらでも可 | `watchdog_reboot()` を発行（以降 応答断→再起動） |

**`MUX_RESET`/`RESCAN` のフロー**：
1. **Core0 ISR**：busy でなければ `req_cmd=opcode; req_seq++`（新規受理）。busy 中の別コマンド書込は拒否（`FAULT.CFG_REJECT`、req 更新せず）。
2. **`CMD` 読み**：Core0 が `(req_seq!=ack_seq) ? 0x01(busy) : result` を返す。
3. **Core1**：ポーリングループ先頭で `req_seq!=ack_seq` を検出したら、巡回の合間に当該コマンドを実行 → `result` 書込 → メモリバリア → `ack_seq=req_seq`（完了公開）。

- `req` は Core0 のみ、`result`/`ack` は Core1 のみが書くため**ロック不要**。`ack_seq` 更新前にメモリバリアを置き `result` の可視性を保証する。
- キュー深さは 0（busy 中は新規受理しない）。上位契約は [command_spec.md](command_spec.md) §7.1。

**`APPLY_NOW`（`DIR_CONFIG` bit7）**：
DIR GPIO は通常 Core1 が `cfg_apply_pending()` で駆動するが、`APPLY_NOW=1` の書込時は **Core0 ISR が SIO 経由で当該 DIR GPIO を直接駆動**して即時反映する（DIR は単純出力で µs で書ける・非ブロッキング原則を満たす）。駆動値は `config.dir_config` から一意に決まるため、Core0 の即時駆動と Core1 の次巡駆動が重なっても結果は同一（冪等・競合無害）。Core0 は併せて `config.dir_config` を更新し Core1 側の整合を保つ。

---

## 8. 主要シーケンス

### 8.1 起動シーケンス

```
1. clocks / GPIO / board 初期化（DIR GPIO(GP5-10)をOUT・初期値=config.dir_config で確定。プルダウン10kΩ実装、[design_spec.md](design_spec.md) §6.4）
2. downstream_i2c 初期化(I2C1,400k)、TCA9548A RESET解除
3. 下流プローブ: mux(0x70)応答確認 → 各ch mux選択しAS5600(0x36)応答確認。応答chを `g_ch_present` に記録し `config.ch_enable` の初期値へ採用（CH_PRESENT/CH_ENABLE, [command_spec.md](command_spec.md) §4.9）
4. AS5600 初期設定（config.angle_src, フィルタ設定を書込）※§5.5.6対応
   ※ DIRは静的方向入力のため CONF 書込の「前」（手順1）で確定済み（[as5600_config.md](as5600_config.md) §5）
5. sensor_data 初期化（両バッファをゼロ/初回サンプルで充填）
6. upstream_i2c 初期化(I2C0,0x42, スレーブISR有効) ← ★ここで初めて上流に応答開始
7. multicore_launch_core1(sampler_run)
8. Core0: 上流サービス＋WDT監視ループへ
   （プローブ失敗chは ch_ok=0 で継続、STATUSにエラー反映）
```

> **★ 上流スレーブの遅延有効化（確定・上位契約）**：手順6（0x42有効化）は**下流プローブ(手順3)・AS5600 CONF書込(手順4)・バッファ初期化(手順5)の後**に置く。これにより 0x42 が応答した時点で全レジスタが有効値・整合データとなり、上位は「WHO_AM_I応答＝完全ready」として扱える（中途半端な状態を見せない）。手順1〜5完了までは 0x42 は NACK。
>
> **起動 ready 時間 予算（目標 ≤100ms）**：手順3-4の前に AS5600 の `T_PU ≥ 10ms`（[as5600_config.md](as5600_config.md) §5）待ちを含む。RP2040 boot＋clock init＋下流init＋T_PU 10ms＋6chプローブ＋CONF書込＋バッファ初期化の合計を **電源投入後 100ms 以内**に収めることを目標とする（上位 controller のタイムアウト初期値 200ms＝上限×2 の根拠, [command_spec.md](command_spec.md) §8.2 / [controller_impl_notes.md](controller_impl_notes.md) §3）。実測で確定し、逸脱時は上限値を見直す。

### 8.2 下流ポーリング状態機械（Core1）

```
ループ先頭 → [CHECK_CMD: req_seq!=ack_seq なら MUX_RESET/RESCAN 実行→result→ack_seq=req_seq]
STATE per ch (config.ch_enable のbitが1のchのみ):  SELECT_MUX → READ_ANGLE → [READ_STATUS/AGC] → NEXT_CH
  ※ 無効ch(ch_enable bit=0)は巡回スキップ（mux選択せず）、shadowに angle=0xFFFF/agc=0xFF/ch_ok=0 を充填
巡回完了 → PUBLISH → APPLY_CONFIG → KICK_WDT → (先頭へ)

異常時遷移:
  READ_* が NACK/timeout → ch_ok[ch]=0、旧値保持、次chへ
  連続失敗 or バス固着    → bus_recover() → 必要ならmux_reset()
```

> `APPLY_CONFIG`（＝`cfg_apply_pending()`）は `config.dirty` 時のみ動作し、(a) 各ch DIR GPIO の駆動、(b) `as5600_conf` 変更時は各ch mux選択→CONF(0x07/0x08)再書込、を行う。CONF再書込は6ch分の下流トランザクションを要するため、変更が無い通常巡回では実行しない（巡回時間を圧迫しない）。再書込を挟んだ巡回の角度は過渡値となり、上位が破棄する前提（[command_spec.md](command_spec.md) §4.8）。

### 8.3 上流スレーブISR（Core0）

```
イベント RECEIVE(1st byte)  : ptr = byte
イベント RECEIVE(2nd以降)   : 書込可レジスタなら適用→config.dirty=1、else無視+ERR
                              ・CMD(0x40)書込  → §7.1 分類：即時系は即実行/下流系はメールボックス受理(busyなら拒否)
                              ・DIR_CONFIG bit7=1 → その場でDIR GPIO直接駆動(APPLY_NOW, §7.1)
イベント REQUEST(読み1st)   : 新規読出なら regs_snapshot() 実行、tx_staging供給開始
                              ・CMD(0x40)読み  → (req_seq!=ack_seq)?0x01:result を供給
イベント REQUEST(読み継続)  : tx_staging[ptr++]（範囲外は0xFF）
イベント FINISH(STOP/RESTART): トランザクション確定（DATA_READY線は不採用のためネゲート処理なし）
```

---

## 9. システム状態管理

```
[BOOT] → [PROBING] → ┬─(全ch OK)→ [RUN]
                      └─(一部/全NG)→ [DEGRADED] ⇄ [RUN]（復旧でRUN復帰）
 いずれの状態でも上流応答は継続（STATUSで健全性を通知）
 致命異常（ISRハング等）→ WDTリセット → [BOOT]
```

STATUSレジスタ（0x02/0x03）へ状態を反映：ch別OK、DEGRADED、エラー種別。

---

## 10. エラー処理・ウォッチドッグ

| 対象 | 方式 |
|------|------|
| Core1ハング | Core1がループ毎に生存カウンタ更新。Core0がカウンタ進行を確認できた時のみ `hardware_watchdog`（`WDT_TIMEOUT_MS`=500ms, §11.1）給餌。停止→WDTリセット |
| Core0/ISRハング | 同上（両コアの生存が揃って初めて給餌） |
| 下流NACK/timeout | `downstream_i2c` が全転送に `DS_XFER_TIMEOUT_US`(1000µs, §11.1) 付与。失敗はch_okに反映し継続 |
| 下流バス固着 | 連続 `DS_FAIL_RECOVER_N`(3回) 失敗で SCL 9クロック＋STOP復旧、連続 `DS_MUXRESET_N`(2巡) 全ch失敗で mux RESET（§11.1） |
| ポインタ暴走/範囲外 | STOP毎にクランプ、範囲外読出は0xFF |
| 上流バス固着 | スレーブは能動駆動不可 → WDTによる自己回復に限定（[i2c_architecture.md](i2c_architecture.md) §8） |

---

## 11. 設定・パラメータ（`board.h` / `config`）

| 種別 | 例 | 場所 |
|------|-----|------|
| コンパイル時 | I2Cインスタンス割付、GPIO番号、mux/センサアドレス、バス速度 | `board.h` |
| コンパイル時 | 使用ch数(6)、tx_stagingサイズ、タイムアウト値 | ビルド定数 |
| 実行時（上位変更可） | angle_src(RAW/filtered)、STATUS間引き率 | `config` / CONFIGレジスタ(0x40) |
| 実行時（上位変更可） | AS5600 CONF の SF/FTH（フィルタ調整） | `config.as5600_conf` / AS5600_CONFレジスタ(0x44/0x45) → 全ch CONF再書込 |
| 実行時（上位変更可） | 各ch回転方向(DIR) | `config.dir_config` / DIR_CONFIGレジスタ(0x42) → DIR GPIO(GP5-10) |
| コンパイル時 | DIR GPIO番号(GP5-10)、TCA9548A RESET(GP4) | `board.h` |

### 11.1 主要ビルド定数の既定値（暫定確定・実機で最終調整）

タイミング収支（[i2c_architecture.md](i2c_architecture.md) §5.5）から導いた既定値。すべて `board.h`／ビルド定数として持ち、§13 の実測で最終調整する。

| 定数 | 既定値 | 根拠 / 挙動 |
|------|--------|------------|
| `WDT_TIMEOUT_MS` | **500 ms** | ハング検出。最長の正当な単一処理（`RESCAN`/`MUX_RESET` ~50ms）を大きく上回り誤トリップを回避しつつ、ハング→リブート→再ready(~100ms, §8.1)で ~600ms 以内に自己回復。hardware_watchdog 上限(~8.3s)内 |
| `DS_XFER_TIMEOUT_US` | **1000 µs** | 下流1転送のタイムアウト。公称 ~170µs/ch（400kHz, [i2c_architecture.md](i2c_architecture.md) §5.5.3）の約6倍。超過で当該chを NACK/timeout 扱い→`ch_ok=0`・旧値保持 |
| `DS_FAIL_RECOVER_N` | **連続 3 回** | 同一下流転送が連続 `DS_FAIL_RECOVER_N` 回失敗で `bus_recover()`（SCL 9パルス+STOP）発動（`FAULT.BUS_RECOVER`） |
| `DS_MUXRESET_N` | **連続 2 巡** | `bus_recover()` 後も巡回が連続 `DS_MUXRESET_N` 回 全ch失敗なら `mux_reset()` へエスカレーション（`STATUS_HI.MUX_FAULT`/`FAULT.MUX_NORSP`） |
| `STATUS_DECIM` 既定 | **9**（≒100Hz） | 全力巡回 ~900-980Hz を 9分周＝約100Hz で STATUS/AGC 更新（角度は毎巡）。0 は無効（`CFG_REJECT`, [command_spec.md](command_spec.md) §4.7） |
| `POLL_PERIOD` 既定 | **0**（全力巡回） | [command_spec.md](command_spec.md) §4.5 |
| ready 上限 | **≤100 ms** | 起動契約（§8.1）。上位 controller のタイムアウト初期値 200ms の根拠 |
| `CMD` busy 目安 | RESCAN/MUX_RESET **~50ms** / SOFT_RESET 応答断 **~100ms** | 実測待ちの暫定値。WDT_TIMEOUT_MS はこれらを上回るよう設定（[controller_impl_notes.md](controller_impl_notes.md) §4） |

> ⚠ `WDT_TIMEOUT_MS` は `CMD` busy 目安・`DS_XFER_TIMEOUT_US × DS_FAIL_RECOVER_N` 等「1回の生存カウンタ更新間隔の最大」より必ず大きく設定する（正当な長処理での誤リセット防止）。実測で busy 時間が伸びた場合は WDT を先に見直す。

---

## 12. ディレクトリ構成・ビルド

```
firmware/
 ├ CMakeLists.txt          # pico-sdk ベース
 ├ src/
 │  ├ main.c
 │  ├ upstream_i2c.c/.h
 │  ├ bridge_regs.c/.h
 │  ├ sampler.c/.h
 │  ├ downstream_i2c.c/.h
 │  ├ drivers/ as5600.c/.h  tca9548a.c/.h
 │  ├ core/   sensor_data.c/.h  config.c/.h  sys_status.c/.h  fault.c/.h
 │  └ board.h
 └ test/                   # ホスト側単体テスト（レジスタ/バッファロジック）
```

- **SDK**：pico-sdk（C）。`pico_multicore`, `hardware_i2c`, `pico_i2c_slave`, `hardware_watchdog` を使用。
- **言語**：C。ISR経路はアロケーション・浮動小数を排除。

---

## 13. 試験・デバッグ観点

| 観点 | 方法 |
|------|------|
| レジスタ/バッファロジック | ホスト単体テスト（ハード非依存に分離した `bridge_regs`/`sensor_data`） |
| コア間整合性 | バースト読出中のswap注入でtear不発生を確認 |
| タイミング | GPIOトグルでポーリング周期・ISR滞在時間をロジアナ計測 |
| 上流互換 | 上位実I2Cドライバ（i2c-dev等）で12バイト一括読出を検証 |
| 異常系 | センサ抜線・mux無応答・バス短絡でDEGRADED/復旧を確認 |

---

## 14. 確定事項 / 未確定事項

### 確定（2026-07-10、[i2c_architecture.md](i2c_architecture.md) §11）
- [x] AS5600フィルタ設定＝**RAW_ANGLE＋SF=4x＋高速フィルタ有（CONF=0x0A00）**。`config.angle_src` 既定値=**0（RAW）**（CONFIG(0x30) bit0 と同一表現：0=RAW/1=ANGLE。§6.3）。起動時に各chへCONF揮発書込（§8.1手順4、詳細 [as5600_config.md](as5600_config.md)）
- [x] DATA_READY線＝**実装しない**。ISRのFINISHでのネゲート処理も不要化（§8.3のDATA_READYネゲートは削除）。健全性はSTATUS、新旧判別はSAMPLE_COUNTで通知
- [x] 上位互換＝**生I2Cのみ（SMBus非対応）**。PEC検証コードは実装不要
- [x] `CMD` コア間ディスパッチ＝**コマンドメールボックス（seq/ack ロックフリー）**で確定。`APPLY_NOW` は Core0 直接駆動（§7.1）
- [x] SF/FTH 実行時変更＝**`AS5600_CONF`(0x44/0x45) レジスタ**、Core1が全ch再書込（§6.3/§8.2、[command_spec.md](command_spec.md) §4.8）
- [x] 主要ビルド定数の既定値＝§11.1 で暫定確定（WDT 500ms / 下流timeout 1ms / 復旧3回・mux reset 2巡 / STATUS_DECIM 9）。実機で最終調整
- [x] 接続ch数（1〜6ch）対応＝**起動プローブ自動検出（`g_ch_present`→CH_PRESENT 0x46）＋上位上書き（`config.ch_enable`←CH_ENABLE 0x47）**で確定。Core1は有効chのみ巡回、無効chは angle=0xFFFF/agc=0xFF/ch_ok=0、DEGRADEDは有効chのみ判定（§6.1/§6.3/§8.2、[command_spec.md](command_spec.md) §11）
- [x] 6ch化に伴い `STATUS` を2バイト(LO/HI)化、`ch_ok`ビットマスクを6bit幅に拡張（§6.1/§9、2026-07-19改訂）
- [x] ログ/デバッグ出力＝**USB-CDCシリアルの監視・保守・強制制御インタフェースとして採用確定**（ビルドオプションで有効/無効切替、既定=有効）。上流I2Cとは独立の第2管理チャネルとし、`usb_console`（Core0, ISR外）/`diag_mailbox`（Core1への下流raw read/write依頼用、`CMD`と同型のロックフリーメールボックス）/`upstream_log`（上流トランザクションのリングバッファ）/`channel_diag`（ch別統計）の4モジュールを追加する。詳細コマンド仕様は [usb_serial_spec.md](usb_serial_spec.md) §7、6ch版実装は `firmware_arduino/firmware_arduino.ino`（2026-07-19確定）
- [x] ステータスLED表示＝**Red(FAULT/CH_FAULTレベル表示)・Yellow(下流生存ハートビート)・Blue(上流通信ハートビート)の3灯を確定採用**（WS2812は将来拡張の予備、未駆動）。`status_led`モジュールを追加、200ms間隔のイベント条件付きトグルで非ブロッキング駆動。詳細は [design_spec.md](design_spec.md) §10（2026-07-19確定）

### 未確定（実装フェーズで決定）
- [ ] 設定変更の一貫性保護：単一ワードは原子的で足りる。**複数フィールド同時変更が要る場合のみ HWスピンロック**（コマンド系は §7.1 メールボックスで別途解決済み・FIFOは不使用に確定）
- [ ] ホスト単体テストのフレームワーク選定（`bridge_regs`/`sensor_data` のハード非依存ロジック対象）
- [ ] `firmware/`（pico-sdkネイティブ版）へのUSBシリアルインタフェース実装要否・優先度（[usb_serial_spec.md](usb_serial_spec.md) §9）
```
