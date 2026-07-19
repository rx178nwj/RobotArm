# 実装プロンプト — マルチI2Cブリッジ ファームウェア（RP2040）

AS5600×6ch を単一I2Cから読み出す **RP2040 ブリッジ ファームウェア**を実装するための指示書（プロンプト）。コーディングエージェント／実装者はこの文書を起点に着手する。

| 項目 | 内容 |
|------|------|
| ドキュメント種別 | 実装指示書（プロンプト） |
| 実装対象 | RP2040 ブリッジ ファームウェア（`firmware/` 新規作成） |
| 関連 | [software_architecture.md](software_architecture.md)（FW構造・最重要）/ [command_spec.md](command_spec.md)（レジスタ確定仕様）/ [design_spec.md](design_spec.md)（HW）/ [as5600_config.md](as5600_config.md)（AS5600設定）/ [i2c_architecture.md](i2c_architecture.md)（通信アーキ）/ [controller_impl_notes.md](controller_impl_notes.md)（対向仕様） |
| 版 | 0.2（3ch初版→6ch実装に追従） |
| 作成日 | 2026-07-11（初版）／2026-07-19 改訂（6ch化） |

> **注記**：現行 `firmware_arduino/firmware_arduino.ino` は `kChannelCount=3`（3ch版）のまま。本書・[command_spec.md](command_spec.md)（v1.0, 6ch）に追従した実装更新が未着手。

> **前提**：設計は上記5文書でほぼ確定済み。回路(KiCad)は `kicad/` に既存、上位コントローラ側ドライバは別システム。本書は**下流センサ集約を担うブリッジFWの実装のみ**を対象とする（§8）。

---

## 0. あなたへの依頼（コピペ用プロンプト）

> あなたは組込みファームウェアエンジニアです。`/home/j0901413/etc/multi_i2c_bridge` の `docs/` にある設計文書を**唯一の正**として、RP2040 ブリッジ ファームウェアを pico-sdk (C) で実装してください。
>
> **成果物**：`firmware/` ディレクトリ一式（pico-sdk ベースの CMake プロジェクト、全モジュールのソース、`board.h`、ホスト単体テスト）。ビルドが通り、`software_architecture.md §12` の構成に一致すること。
>
> **進め方**：下記 §4 の実装順序に従い、フェーズごとにビルド可能な状態を保つ。仕様で確定済みの事項（§1）は文書どおりに実装し、勝手に変えない。未確定事項（§6）はコンパイル時定数／`TODO(HW検証)` コメントで明示し、暫定既定値で先行実装する。実装判断が割れる箇所は、該当する docs のセクション番号を引用して根拠を示すこと。
>
> **禁止事項**：ISR 経路での動的確保・浮動小数点の使用、高頻度パス（センサ値）へのロック導入、確定レジスタマップ（`command_spec.md §3`）のオフセット／意味の変更、遅延有効化契約（§8.2）の破壊。

---

## 1. 実装が従うべき確定仕様（変更禁止）

一次情報とセクション：

| 文書 | 役割 |
|------|------|
| `software_architecture.md` | FW内部構造・モジュール分割・デュアルコア実行モデル・データモデル（**最重要**） |
| `command_spec.md` | 上流レジスタマップ確定仕様（オフセット・ビット定義・トランザクション形式） |
| `design_spec.md` | HW・ピン割当・電源・DIR制御・GPIO |
| `as5600_config.md` | AS5600 CONF 値（0x0A00）・起動シーケンス・T_PU |
| `i2c_architecture.md` | 通信アーキ・タイミング収支・確定パラメータ |
| `controller_impl_notes.md` | 上位側の契約（FW側が守るべき対向仕様の確認用） |

必ず守る確定事項（抜粋・詳細は各文書）：

- **役割**：Core0＝上流I2Cスレーブ応答（0x42, 400kHz）／Core1＝下流I2Cマスタ ポーリング（TCA9548A 0x70 + AS5600×6 各0x36, 400kHz）。ベアメタル（RTOSなし）。
- **データ整合性**：ダブルバッファ ＋ 読み出しトランザクション開始時に `tx_staging[]` へスナップショット。部分更新は publish しない。原子的 index swap、高頻度パスはロックフリー（`software_architecture.md §6/§7`, `i2c_architecture.md §4`）。
- **角度ソース既定＝RAW_ANGLE (0x0C/0x0D)**。`config.angle_src` は **0=RAW / 1=ANGLE**（CONFIG 0x40 bit0 と同一表現・素通し）。AS5600 CONF 起動値＝**0x0A00**（`as5600_config.md §1/§2`）。
- **レジスタマップは `command_spec.md §3` の完全版が正**（`design_spec.md §5.2` は概要）。未定義読み=0xFF、R領域書込=無視+`FAULT.CFG_REJECT`、多バイトは LE。`STATUS`は2バイト(LO/HI)化されている点に注意（v1.0, §9）。
- **接続ch数対応**：起動プローブで `CH_PRESENT`(0x46) 自動検出→`CH_ENABLE`(0x47) 初期値に採用。有効chのみ巡回、無効chは angle=0xFFFF/agc=0xFF/ch_ok=0・DEGRADED対象外。有効なのに無応答は故障（DEGRADED＋`CH_FAULT.CHn_COMM`）。
- **遅延有効化（起動契約）**：上流スレーブ0x42は下流プローブ・CONF書込・バッファ初期化の**完了後**に有効化。応答＝完全ready。電源投入後 ≤100ms 目標（`software_architecture.md §8.1`, `command_spec.md §8.2`）。
- **CMD 機構**：`NOP`/`CLEAR_FAULT` は Core0 即時、`MUX_RESET`/`RESCAN` は seq/ack ロックフリー メールボックス経由で Core1、`SOFT_RESET` は `watchdog_reboot()`。busy中の新規コマンドは拒否（キュー深さ0）（`software_architecture.md §7.1`, `command_spec.md §7`）。
- **DIR 制御**：GP5-10 を OUT で駆動（6ch分）。`DIR_CONFIG`(0x42) bit0-5＝方向、bit7=APPLY_NOW（Core0がその場で直接駆動、冪等）。
- **割込み通知線なし**（純周期ポーリング）。SMBus非対応（PEC/ARA実装しない）。

---

## 2. 技術スタック・制約

- **SDK**：pico-sdk（C）。使用ライブラリ：`pico_multicore`, `hardware_i2c`, `pico_i2c_slave`, `hardware_watchdog`, `hardware_gpio`, `pico_stdlib`。
- **言語**：C（C11想定）。**ISR 経路でアロケーション・浮動小数点を使わない**。
- **ビルド**：CMake（pico-sdk 標準）。ターゲット＝RP2040＋外部QSPI Flash。
- **ホスト単体テスト**：ハード非依存に切り出した `bridge_regs` / `sensor_data` のロジックを host ビルドで検証（フレームワークは軽量なもの、例：Unity か単純な assert ベース。§14 未確定なので選定して明記）。

---

## 3. ディレクトリ構成（`software_architecture.md §12` に一致させる）

```
firmware/
 ├ CMakeLists.txt
 ├ pico_sdk_import.cmake
 ├ src/
 │  ├ main.c                 # Core0: 初期化・下流プローブ・Core1起動・WDT監視ループ
 │  ├ upstream_i2c.c/.h       # Core0: I2C0 スレーブ設定＋ISR、bridge_regsへ委譲
 │  ├ bridge_regs.c/.h        # Core0: レジスタマップ、ptr管理、snapshot生成、書込適用（★host-testable）
 │  ├ sampler.c/.h            # Core1: 下流ポーリング状態機械
 │  ├ downstream_i2c.c/.h     # Core1: I2C1マスタ blocking+timeout ヘルパ
 │  ├ drivers/
 │  │  ├ as5600.c/.h          # 角度/STATUS/AGC/CONF R/W
 │  │  └ tca9548a.c/.h        # mux選択・reset
 │  ├ core/
 │  │  ├ sensor_data.c/.h     # ダブルバッファ publish/snapshot（★host-testable）
 │  │  ├ config.c/.h          # 実行時設定＋dirtyフラグ
 │  │  ├ sys_status.c/.h      # STATUS/FAULT 集約
 │  │  └ fault.c/.h           # WDT給餌・バス復旧・muxリセット判断
 │  └ board.h                 # ピン/I2Cインスタンス/アドレス/ビルド定数（定数のみ）
 └ test/                       # ホスト単体テスト
```

---

## 4. 実装順序（各フェーズ末でビルド可能を維持）

1. **足場**：`CMakeLists.txt` + `board.h`（§5 の全定数）+ 空モジュールのスタブ。pico-sdk でビルドが通ること。
2. **ドメイン層（ハード非依存・先にテスト）**：
   - `sensor_data`（`sensor_snapshot_t`、ダブルバッファ、`sd_publish`/`sd_snapshot`、原子的index）。
   - `bridge_regs`（レジスタマップ、`regs_on_write`/`regs_on_read_byte`/`regs_on_finish`/`regs_snapshot`、ptrクランプ、無効値拒否）。
   - `config` / `sys_status`。
   - → `test/` でホスト単体テスト（tear不発生、範囲外=0xFF、LE、CFG_REJECT、CH_ENABLE挙動）。
3. **下流ドライバ**：`downstream_i2c`（timeout付き）→ `tca9548a` → `as5600`。
4. **Core1 sampler**：状態機械（CHECK_CMD → 有効ch巡回 SELECT/READ_ANGLE/[STATUS/AGC間引き] → PUBLISH → APPLY_CONFIG → KICK_WDT）。
5. **Core0 upstream**：`upstream_i2c` ISR（RECEIVE/REQUEST/FINISH）＋ CMD メールボックス。
6. **main 起動シーケンス**：§8.1 の手順1〜8（**遅延有効化厳守**）。
7. **fault/WDT・バス復旧**：両コア生存カウンタ揃いで給餌、SCL9パルス+STOP、mux reset エスカレーション。
8. **統合・実機検証**：§13 の観点（ロジアナでタイミング、i2c-devで15バイト一括リード、異常系）。

---

## 5. コンパイル時定数（`board.h` / `software_architecture.md §11.1`）

```c
// --- I2C インスタンス・GPIO（design_spec.md §6.4）---
#define UP_I2C        i2c0
#define UP_SDA_GPIO   0
#define UP_SCL_GPIO   1
#define DS_I2C        i2c1
#define DS_SDA_GPIO   2
#define DS_SCL_GPIO   3
#define MUX_RESET_GPIO 4          // Low active
#define DIR_GPIO_CH0  5
#define DIR_GPIO_CH1  6
#define DIR_GPIO_CH2  7
#define DIR_GPIO_CH3  8
#define DIR_GPIO_CH4  9
#define DIR_GPIO_CH5  10
#define BLUE_LED_GPIO 25          // WisdPi Tiny RP2040 onboard
#define YELLOW_LED_GPIO 27        // 基板側 LED_STAT2
#define RED_LED_GPIO  28          // 基板側 LED_STAT1
#define WS281_GPIO    29          // WisdPi Tiny RP2040 onboard

// --- アドレス ---
#define BRIDGE_ADDR   0x42        // 上流スレーブ
#define MUX_ADDR      0x70        // TCA9548A
#define AS5600_ADDR   0x36        // 全ch共通

// --- バス速度 ---
#define I2C_BAUD_HZ   400000      // 上下流とも Fast

// --- 識別・既定値 ---
#define WHO_AM_I_VAL  0xB6
#define VERSION_VAL   0x10        // major=1/minor=0（6ch化, command_spec.md v1.0）
#define AS5600_CONF_DEFAULT 0x0A00

// --- 動作パラメータ（実機で最終調整）---
#define WDT_TIMEOUT_MS      500
#define DS_XFER_TIMEOUT_US  1000
#define DS_FAIL_RECOVER_N   3
#define DS_MUXRESET_N       2
#define STATUS_DECIM_DEFAULT 9    // ≒100Hz（6ch全力巡回~900-980Hzを9分周）、0は無効(CFG_REJECT)
#define POLL_PERIOD_DEFAULT  0    // 全力巡回
#define AS5600_T_PU_MS      10     // パワーアップ待ち
#define READY_BUDGET_MS     100    // 起動ready上限(目標)
```

---

## 6. 未確定事項（暫定値で先行実装し、コードに明示）

`TODO(HW検証)` コメントを付け、実機検証で確定する：

- **SF/FTH が RAW_ANGLE に効くか未確定**（`as5600_config.md §3`）。CONF=0x0A00 は暫定既定として実装。効果評価は CONFIG bit0=1(ANGLE) 切替で行う。
- **CMD busy 継続時間未実測**（RESCAN/MUX_RESET ~50ms, SOFT_RESET ~100ms 想定）。`WDT_TIMEOUT_MS` はこれらを必ず上回る設定を維持（`software_architecture.md §11.1` の⚠）。
- **起動 ready 時間の実測**（≤100ms 目標）。逸脱時は定数見直し。
- **全ch無応答(0ch検出)時に 0x42 を有効化するか**（`command_spec.md §10/§11.4`）→ 現状は「有効化して STATUS で通知」方針で実装、要確認コメントを残す。
- **ホスト単体テストのフレームワーク選定**（`software_architecture.md §14`）。
- **ログ出力(UART/USB-CDC)の要否**（同 §14）。既定は無効、ビルドフラグで切替可能に。

---

## 7. 受け入れ基準（Done の定義）

- [ ] `firmware/` が pico-sdk で警告なくビルドでき、UF2 が生成される。
- [ ] ディレクトリ／モジュール構成が `software_architecture.md §12` に一致。
- [ ] レジスタマップが `command_spec.md §3` と完全一致（オフセット・R/W・リセット値・ビット定義）。
- [ ] `bridge_regs`/`sensor_data` のホスト単体テストが通る（tear不発生・LE・範囲外0xFF・CFG_REJECT・CH_ENABLE分岐）。
- [ ] 遅延有効化：手順1〜5完了まで 0x42 が NACK、以降 WHO_AM_I=0xB6 応答。
- [ ] 実機で 15バイト一括リード(0x10–0x1E)が一貫スナップショットで取得でき、SAMPLE_COUNT が publish毎に+1。
- [ ] 異常系（センサ抜線・mux無応答・下流固着）で DEGRADED／バス復旧／mux reset が定義どおり動作。
- [ ] 未確定事項（§6）が `TODO(HW検証)` として明示され、暫定値で動作する。

---

## 8. 補足：対象外（別成果物）

- **KiCad 回路図/PCB**：`kicad/` に既存（`kicad/README.md` 参照）。本プロンプトの対象外だが、ピン割当は `design_spec.md §6.4` を FW と一致させること。
- **上位コントローラ側ドライバ**：別システム。`command_spec.md`＋`controller_impl_notes.md` が対向仕様。本 FW はその契約（遅延有効化・LE・15バイト一括・CMD busy契約）を満たす側として実装する。
