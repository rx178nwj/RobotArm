# コントローラ側 実装注意点・未確定事項

上位コントローラ（I2Cマスタ）側の通信ドライバを**別システムで実装・構築する際**の注意点集。
[command_spec.md](command_spec.md)（確定仕様）と併せて参照すること。本書は「仕様として未確定・文書間で矛盾・実装者が誤りやすい点」を実装着手前チェックリストとして集約する。

| 項目 | 内容 |
|------|------|
| 対象 | 上位コントローラ側 I2Cマスタ通信ドライバ実装者 |
| 関連 | [command_spec.md](command_spec.md)（確定仕様・本書の前提）/ [i2c_architecture.md](i2c_architecture.md) / [design_spec.md](design_spec.md) / [software_architecture.md](software_architecture.md) / [as5600_config.md](as5600_config.md) |
| 版 | 0.2（3ch初版→6ch実装に追従） |
| 作成日 | 2026-07-10（初版）／2026-07-19 改訂（6ch化） |

> **位置づけ**：[command_spec.md](command_spec.md) はバイト列・レジスタの**確定仕様**。本書はそれを実装に落とす際の**リスクと未確定点**を扱う。基本実装（疎通・6ch角度一括読み・設定書込・エラークリア）は command_spec.md のみで着手可能だが、下記 §1 を確定せずに「正しい」実装は完成しない。

---

## 0. 重大度サマリ

| # | 項目 | 重大度 | 実装への影響 | 状態 |
|---|------|--------|-------------|------|
| 1 | 既定 角度ソースの文書間矛盾 | **高** | 起動直後に読める角度の性質が不定 | ✅ 解消済（全文書 RAW_ANGLE 既定・§1） |
| 2 | `VERSION` エンコード | 中 | 互換性チェック実装 | ✅ 確定（4/4 nibble・major一致要求・§2） |
| 3 | ブリッジ起動 ready 時間 | 中 | 起動時リトライ/待機の設計 | ✅ 契約確定（遅延有効化・≤100ms・§3） |
| 4 | `CMD` busy 継続時間 未実測 | 低 | 完了待ちタイムアウト根拠なし | ☐ 暫定値で回避可 |
| 5 | 上流バス復旧はマスタ責務（詳細なし） | 低 | 一般I2C知識で補える | 情報 |

---

## 1.【解消済】既定 角度ソース（RAW vs フィルタ後ANGLE）

> **【解消 2026-07-10】** かつて i2c_architecture.md のみ「高速フィルタ後 ANGLE が既定」と食い違っていたが、**全設計文書を RAW_ANGLE 既定に統一**して解消。あわせて内部変数 `config.angle_src` の数値表現も CONFIG レジスタ bit0 と同一（0=RAW/1=ANGLE）に統一した。本節は経緯と controller への影響の記録として残す。

確定内容：
- **既定 角度ソース＝RAW_ANGLE (0x0C/0x0D)**（全文書一致：[command_spec.md §4.4](command_spec.md) / [design_spec.md §8](design_spec.md) / [as5600_config.md §1](as5600_config.md) / [i2c_architecture.md §9/§11.2](i2c_architecture.md) / [software_architecture.md §6.3](software_architecture.md)）。
- **数値表現＝0=RAW（既定）/ 1=ANGLE**。ホスト視点の CONFIG bit0 と FW内部 `config.angle_src` が同一表現で、`config.angle_src = CONFIG & 0x01` の素通し対応（反転なし）。

### controller への影響（参考）
- スケーリング式 `deg = raw * 360.0 / 4096.0` はどちらのソースでも成立（値域 0–4095 は共通）。
- 既定 RAW_ANGLE の特性：**生ノイズ大** / **0/360°境界ヒステリシスなし** / **OTP非依存**。フィルタ効果が必要なら `CONFIG`(0x40) bit0=1 で ANGLE(0x0E/0x0F) へ切替（切替直後サンプルは破棄・§6）。

### 実装者の推奨（任意）
- 既定が RAW_ANGLE に確定したため、起動時の `CONFIG` 明示書込は必須ではない。ただし移植先の堅牢性重視なら、起動時に `CONFIG`(0x40) を明示書込して期待ソースを固定してもよい（既定に依存しない防御的実装）。

---

## 2.【確定】`VERSION`(0x01) エンコードと互換性チェック

> **【確定 2026-07-10】** エンコード＝**4bit major / 4bit minor**、互換ポリシー＝**major一致要求**（minor差異は警告のみ継続）。詳細は [command_spec.md §9.1/§9.2](command_spec.md)。

### 確定内容
- **エンコード**：`VERSION = (major<<4) | minor`。`major=(v>>4)&0x0F` / `minor=v&0x0F`。
- **初版FW = `0x01`**（v0.1）。表記 `v<major>.<minor>`（例 0x12=v1.2）。
- **major を上げる＝後方互換を壊す変更**（既存オフセット意味変更・再配置等）。予約領域への追加のみなら minor を上げる。

### 実装者の対処（推奨実装）
起動時（[command_spec.md §8.2](command_spec.md) 手順1で `VERSION` 取得後）：

```c
uint8_t v = read_reg(0x01);
if ((v >> 4) != EXPECTED_MAJOR)      // 非互換 → 停止（レジスタ意味が変わっている可能性）
    fatal("bridge FW major mismatch");
if ((v & 0x0F) != EXPECTED_MINOR)    // minor 差異 → 警告のみで継続（後方互換）
    log_warn("bridge FW minor differs: v%u.%u", v>>4, v&0x0F);
```

- **major 不一致は致命**（続行しない）。**minor 差異は許容**。
- 特定 minor 以上の追加機能に依存する controller のみ、必要に応じ最小 minor を追加検証する。

---

## 3.【確定】ブリッジ「電源投入後 ready 時間」と起動契約

> **【確定 2026-07-10】** 起動契約を確定：**遅延有効化＋ready上限 ≤100ms**。以下を controller の起動シーケンスの正とする。

### 確定した契約
- **遅延有効化**：ブリッジは上流スレーブ(0x42)を**下流プローブ・AS5600 CONF書込・バッファ初期化の完了後**に有効化する（[software_architecture.md §8.1](software_architecture.md) 手順6）。
- **応答＝完全ready＝データ有効**：0x42 が ACK し `WHO_AM_I=0xB6` を返した時点で、全レジスタが有効値・整合データ。**中途半端な状態は上位に見えない**。それ以前は NACK。
- **ready 上限＝電源投入後 ≤100ms**（AS5600 `T_PU 10ms`＋下流プローブ＋CONF書込＋バッファ初期化を含む目標上限, [command_spec.md §8.2](command_spec.md)）。
- 注意：[as5600_config.md §5](as5600_config.md) の `T_PU ≥ 10ms` は**下流 AS5600 のパワーアップ時間**であり、ブリッジ全体の ready 時間はそれを内包した上記 ≤100ms（混同しないこと）。

### 実装者の対処（推奨実装）
- 起動シーケンスを**リトライ前提**で実装する（[command_spec.md §8.2](command_spec.md) 手順0）：
  - `WHO_AM_I`(0x00) が `0xB6` を返すまで、**10ms間隔**で NACK/不正値を許容してポーリング。
  - **タイムアウト初期値＝200ms**（ready上限 ≤100ms ×2 の余裕）。超過時はエラー扱い（配線/電源/FW を確認）。
- `SOFT_RESET`(CMD=0xA5) 後の再 ready 待ちにも同じポーリングを流用する。
- ⚠ ready 上限 100ms は目標値。FW実測で逸脱した場合は上限・タイムアウト初期値を見直す（[software_architecture.md §8.1](software_architecture.md) の予算参照）。

---

## 4. `CMD`(0x50) の busy 継続時間が未実測

- `RESCAN` / `MUX_RESET` / `SOFT_RESET` の実処理時間は [command_spec.md §10](command_spec.md) で☐（実測待ち）。
- `SOFT_RESET` は [command_spec.md §7.1](command_spec.md) が「数十ms応答断」とのみ記載。

### 実装者の対処
- 完了確認は [command_spec.md §7.2](command_spec.md) どおり `CMD` が `idle(0x00)` になるまでポーリング。
- タイムアウトは**暫定値で先行実装可**（実測確定後に調整）：
  - `SOFT_RESET`：応答断込みで 100ms 程度＋NACKリトライ
  - `RESCAN` / `MUX_RESET`：50ms 程度
  - `CLEAR_FAULT` / `NOP`：即時（数ms）
- `SOFT_RESET` 実行中はスレーブが NACK を返すため、**マスタ側は NACK を異常としない**設計にする。
- **busy 中の新規コマンドは拒否される（キュー深さ0）**：`CMD` が busy(0x01) の間に別コマンドを書くと無視され `FAULT.CFG_REJECT` がセットされる（[command_spec.md](command_spec.md) §7.1）。**必ず idle(0x00) を確認してから次のコマンドを発行**すること。連続してコマンドを投げる実装は誤り。

---

## 5. 上流バス復旧はマスタ（controller）の責務

- ブリッジはスレーブのため上流 SCL を能動駆動できず、**上流バス固着の復旧は上位の責務**（[command_spec.md §6](command_spec.md) / [i2c_architecture.md §8](i2c_architecture.md)）。ブリッジ側は WDT による自己回復に留まる。
- 手順の詳細は文書化されていないが、一般的なI2Cマスタの標準対処（**SCL を 9 クロック生成 → STOP 発行**でスレーブのビット送出状態を解除）で足りる。

### 実装者の対処
- 使用するI2Cコントローラ／ドライバのバス復旧機能（Linux なら `I2C_M_...` やコントローラのリカバリ、MCU なら手動 GPIO トグル）を組み込む。
- ブリッジ側の WDT リセットは数十ms要するため、上流復旧後も `FAULT.WDT_RESET`([command_spec.md §4.2](command_spec.md)) を確認し、必要なら再初期化する。

---

## 6. その他 実装時に踏みやすい注意点（確定仕様内だが誤りやすい）

これらは [command_spec.md](command_spec.md) に定義済みだが、他システム移植時に見落とされやすい点。

| 注意点 | 対処 | 根拠 |
|--------|------|------|
| **クロックストレッチ許容が必須** | マスタは µsオーダのクロックストレッチを許容する設定にする（無効化しない） | [command_spec.md §1.1](command_spec.md) |
| **バイトオーダは LE** | `angle = d0 \| (d1<<8)` の順。ビッグエンディアン実装は誤り | [command_spec.md §5.1](command_spec.md) |
| **12bit マスク必須** | 復元後 `& 0x0FFF`（上位nibbleは0だが安全のため） | [command_spec.md §5.1](command_spec.md) |
| **`CHn_OK=0` の ch は無効として破棄** | 有効chの故障は旧値保持・AGC=0、無効ch(未使用)は角度0xFFFF・AGC=0xFF。いずれも値を有効視しない | [command_spec.md §4.1/§5.4](command_spec.md) |
| **健全性判定は `CH_ENABLE` でマスク（6ch固定にしない）** | 1〜5ch構成に対応。`ok=(STATUS_LO & CH_ENABLE & 0x3F)==(CH_ENABLE & 0x3F)`。無効chスロット(0xFFFF)は読み捨て。実装ch数固定の製品は起動時に `CH_PRESENT`(0x46) を期待値照合 | [command_spec.md §4.9/§11](command_spec.md) |
| **範囲外リードは 0xFF（エラーにならない）** | 0xFF を有効データと誤認しない。ポインタ範囲を意識 | [command_spec.md §6](command_spec.md) |
| **15バイト一括読み（0x10–0x1E）推奨** | 角度＋STATUSミラー＋鮮度を1トランザクションの整合スナップショットで取得。別途 0x02-0x03/0x08 を読む往復不要 | [command_spec.md §3.1](command_spec.md) |
| **新旧判別は SAMPLE_COUNT/SAMPLE_LO 差分** | 差=0 は未更新（オーバーサンプル）。6ch全力巡回は~900-980Hzのため1kHz読みでは差=0が常態化しうる（[i2c_architecture.md](i2c_architecture.md) §5.5.3/5.5.4）。`SAMPLE_LO`(0x1E) 下位1バイトで255巡まで一意 | [command_spec.md §4.3](command_spec.md) |
| **DIR/角度ソース切替直後のサンプルは破棄** | 方向反転・ソース切替は出力に不連続を生む。切替直後数サンプルを捨てて再取得 | [command_spec.md §4.6](command_spec.md) |
| **上流プルアップの実装責任** | 上流SDA/SCLプルアップは上位側かブリッジ側の**どちらか一方**に実装（二重実装で下がりすぎ注意） | [design_spec.md §6.2](design_spec.md) |

---

## 7. 実装着手前チェックリスト

- [x] §1：既定 角度ソースは設計判断で **RAW_ANGLE に1本化済**（数値表現も 0=RAW/1=ANGLE に統一）。必要なら起動時 `CONFIG` 明示書込で防御可
- [x] §2：`VERSION` **確定済**（4/4 nibble・初版0x01）。controller は起動時に **major一致を要求**、minor差異は警告のみで実装する
- [x] §3：起動契約 **確定済**（遅延有効化・ready≤100ms）。controller は `WHO_AM_I` を10ms間隔ポーリング・タイムアウト初期値200msで実装する
- [ ] §4：`CMD` 完了待ちに暫定タイムアウト＋NACK許容を実装した
- [ ] §5：マスタ側 上流バス復旧手順を組み込んだ
- [ ] §6：LE・12bitマスク・CHn_OK無効視・クロックストレッチ許容を確認した
- [ ] 実機：0x42 応答・15バイト一括リード疎通を確認した（[command_spec.md §10](command_spec.md)）
