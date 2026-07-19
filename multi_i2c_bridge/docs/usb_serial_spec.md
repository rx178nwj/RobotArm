# USBシリアル 監視・デバッグインタフェース仕様書

ブリッジマイコン（RP2040）の USB-CDC シリアルに対する、テキストコマンドベースの監視・保守・強制制御インタフェースの確定仕様。
上流I2C（[command_spec.md](command_spec.md)）とは**独立した第2の管理チャネル**であり、通常のI2Cブリッジ動作（上流応答・下流ポーリング）を止めずに使う。

| 項目 | 内容 |
|------|------|
| 対象 | USB-CDCシリアル（Host PC ⇔ RP2040ブリッジ, デバッグ/保守用） |
| 関連 | [design_spec.md](design_spec.md) §9（位置づけ）/ [command_spec.md](command_spec.md)（上流I2Cレジスタの正）/ [software_architecture.md](software_architecture.md)（FW構造） |
| 版 | 1.0（6ch確定仕様。3ch版 `firmware_arduino/firmware_arduino.ino` の実装を6ch化・仕様化したもの） |
| 作成日 | 2026-07-19 |
| 実装状況 | `firmware_arduino/firmware_arduino.ino` に **6ch版実装済み**（`ch <0..5>`, DIR=GP5-10, レジスタマップはcommand_spec.md v1.0に追従。2026-07-19）。`firmware/`（pico-sdkネイティブ版）は未実装（§9） |

---

## 1. 目的・位置づけ

上位コントローラ向けの上流I2Cレジスタ（[command_spec.md](command_spec.md)）は「必要最小限のホットパス」に絞った設計であり、詳細な診断情報（通信ログ、per-ch統計、raw AS5600アクセス等）を持たない。本インタフェースはこれを補完し、開発・製造検査・現場デバッグ時に以下を可能にする：

1. **ブリッジ状態の監視**：下流各chの接続状態、サンプリング周期、取得済みデータ（角度/AGC/磁石検出）、上流マスタの接続・通信状況、取得状況（サンプルカウント・鮮度）。
2. **保守操作**：エラークリア、mux/センサの再検出、個別chの有効/無効化・回転方向設定、ソフトリセット。
3. **AS5600への強制コマンド送信**：ブリッジの管理下にある下流AS5600へ、通常の巡回とは別に**任意のレジスタ読み書きを直接発行**し、状態を強制的に調整・確認する（診断・製造検査・現場チューニング用）。

**設計原則**：
- 通常運用（上流I2Cスレーブ応答・下流ポーリング）を**一切ブロックしない**。USBシリアル処理はCore0メインループのポーリング（I2C ISR待機の合間）で行い、ISR内では出力しない（[software_architecture.md](software_architecture.md) §5と同じ非ブロッキング原則）。
- 強制コマンド（AS5600 raw read/write）はCore1の下流ポーリング状態機械へ**コマンドメールボックス経由**で依頼し、下流バスの排他アクセスを保証する（[command_spec.md](command_spec.md) §7.1の`CMD`メールボックスと同型の機構を診断専用に複製）。
- 人間が読める**テキスト行プロトコル**とし、専用ツール無しでターミナルソフト（例: PuTTY, screen, Arduino Serial Monitor）から直接操作できる。

---

## 2. 物理層・トランスポート

| 項目 | 値 |
|------|-----|
| インタフェース | USB-CDC（RP2040ネイティブUSB, USB-Bootloader経由の書込みとは別） |
| ボーレート | 115200（USB-CDCのため実際は無視されるが、互換性のため明示） |
| フォーマット | 8N1 |
| 改行 | 送信は `\n` または `\r\n` を受理。応答は `\r\n` 終端 |
| 文字コード | ASCII |
| 有効化 | ビルドオプション（[software_architecture.md](software_architecture.md) §14、既定=有効。無効ビルドではUSB-CDC自体を提供しない） |

---

## 3. コマンドライン仕様

- 1行1コマンド。空白/タブ区切りでトークン化。
- コマンド名・サブコマンドは大文字小文字を区別しない（小文字に正規化）。
- 数値引数は10進または `0x` 接頭辞の16進を受理。
- 不正な引数・構文エラーは `ERR <理由>` を返す。成功は `OK ...` または該当データ行を返す。
- 応答は同期的（1コマンド送信→対応する応答を受信してから次を送る運用を推奨。ラインバッファは未処理分を貯める）。
- **入力バッファ**：1行の最大長・1ループでの最大処理行数を制限し、フラッディングでもブリッジ本来動作に影響しない（実装値は[software_architecture.md](software_architecture.md) §11.1準拠、目安：行長127byte・1ループ64byte）。

---

## 4. 監視コマンド

### 4.1 `help` / `?`

コマンド一覧を表示。

### 4.2 `status`

ブリッジ全体の健全性サマリ。[command_spec.md](command_spec.md) の `STATUS_LO/HI`・`FAULT`・`CH_FAULT`・`CH_PRESENT`・`CH_ENABLE`・`SAMPLE_COUNT`・`CMD` に対応する内容を1行で提示し、`FAULT`/`CH_FAULT` を名称でデコードする。

出力例（6ch）：
```
STATUS status_lo=0x3F status_hi=0x00 fault=0x00 ch_fault=0x00 present=0x3F enable=0x3F samples=1234567 cmd=0x00 uptime_ms=98765
DOWNSTREAM bus_recoveries=0 mux_resets=0 rescans=1
FAULTS none
CH_FAULTS none
```

- `status_lo`/`status_hi`：[command_spec.md](command_spec.md) §4.1 の `STATUS_LO`/`STATUS_HI` そのもの（bit0-5=ch0-5 OK、DEGRADED/DATA_NEW/MUX_FAULT/ERR）。
- `fault`/`ch_fault`：§4.2 の `FAULT`/`CH_FAULT`。
- `present`/`enable`：§4.9 の `CH_PRESENT`/`CH_ENABLE`（6ch, bit0-5）。
- `DOWNSTREAM` 行：バス復旧・mux reset・rescan の累積回数（起動来のカウンタ、`stats clear` でクリア）。

### 4.3 `channels`

下流各ch（ch0-5）の接続状態・サンプリング結果・通信統計を一覧表示する。「i2cスレーブ側デバイスの接続状態」「取得したデータ」を1コマンドで確認できる中核コマンド。

出力例（6ch, ch2が未接続、ch4が故障中の例）：
```
CH PRESENT ENABLE OK DIR_CFG DIR_OUT ANGLE DEGREE  AGC MAG_RAW MD ML MH READ_OK  READ_ERR LAST_OK_MS LAST_ERR_MS
0  1       1      1  0       0       2748   241.578 128 0x20    1  0  0  98765    0        123        0
1  1       1      1  0       0       0512   45.000  130 0x20    1  0  0  98765    0        123        0
2  0       0      0  0       0       invalid invalid 255 0xFF    0  0  0  0        0        0          0
3  1       1      1  0       0       3900   342.773 126 0x20    1  0  0  98765    0        123        0
4  1       1      0  0       0       1024   90.000  0   0x00    0  0  0  50000    120      45000      98700
5  1       1      1  1       1       0999   87.891  131 0x20    1  0  0  98765    0        123        0
```

列定義：

| 列 | 意味 |
|----|------|
| `CH` | チャネル番号 0-5 |
| `PRESENT` | `CH_PRESENT` の該当bit（起動プローブ/RESCANでの実装検出） |
| `ENABLE` | `CH_ENABLE` の該当bit（巡回対象か） |
| `OK` | `STATUS_LO.CHn_OK`（磁石検出OK かつ通信OK） |
| `DIR_CFG` | `DIR_CONFIG` の該当bit（設定値） |
| `DIR_OUT` | 実際のDIR GPIO出力レベル（`DIR_CFG` との差分は反映待ちの可能性を示す） |
| `ANGLE`/`DEGREE` | 現在の角度（RAW/ANGLE いずれか、`CONFIG.ANGLE_SRC` に従う）と度数換算。無効ch(`ENABLE=0`)は `invalid` |
| `AGC` | AGC値。故障chは`0`、無効chは`255`（[command_spec.md](command_spec.md) §5.4のマーカに一致） |
| `MAG_RAW`/`MD`/`ML`/`MH` | AS5600 STATUSレジスタ生値とデコード（磁石検出/弱/強） |
| `READ_OK`/`READ_ERR` | 起動来の下流読み出し成功/失敗回数（ch別） |
| `LAST_OK_MS`/`LAST_ERR_MS` | 直近成功/失敗の`millis()`タイムスタンプ |

### 4.4 `config`

現在の実行時設定（`CONFIG`/`POLL_PERIOD`/`STATUS_DECIM`/`AS5600_CONF`/`CH_ENABLE`/`DIR_CONFIG` の実効値）を表示。

```
CONFIG angle_src=RAW poll_period_ms=0 status_decim=9 as5600_conf=0x0A00 ch_enable=0x3F dir_config=0x00 dir_applied=0x00
```

### 4.5 `master`

上流（Controller⇔ブリッジ, 0x42）の通信カウンタ。「マスタの接続状態、取得状況」に対応。

```
MASTER write_tx=45231 write_bytes=90462 read_req=612045 read_bytes=9180675 last_activity_ms=98765 log_seq=657276
```

- `last_activity_ms`：直近の上流トランザクション時刻。この値が更新され続けていれば上位コントローラが生きて通信していることを示す（「マスタの接続状態」の実体）。
- `master clear`：カウンタとログ（§4.6）をクリア。

### 4.6 `log [件数|clear]`

上流マスタからの直近トランザクションログ（固定長リングバッファ、既定深さ64件）。

```
> log 3
LOG entries=3 latest=657276
#657274 t=98700ms W reg=0x42 len=1 data=82
#657275 t=98730ms R reg=0x10 len=15 data=BC 0A 12 05 ...
#657276 t=98765ms R reg=0x02 len=1 data=3F
```

- `W`=上位からの書込（`reg`=開始レジスタ、`data`=書込バイト列）、`R`=上位への応答（`reg`=読出開始レジスタ、`data`=返却バイト列の先頭N件、最大表示長あり）。
- I2C割込み内ではUSB出力を行わない（イベントのみリングバッファに記録、シリアル出力はメインループで遅延実行）。
- `log clear`：`master clear` と同じ扱い（ログとカウンタを同時クリア）。

### 4.7 `monitor <100..60000|off>`

指定周期[ms]で `status` と `channels` を自動的に継続出力する。`off` で停止。ポーリング型の簡易リアルタイムモニタ。

```
> monitor 1000
OK monitor period_ms=1000
```

---

## 5. 保守コマンド

| コマンド | 動作 | 対応する上流コマンド |
|----------|------|---------------------|
| `rescan` | 下流プローブ再実行、`CH_PRESENT` 更新 | `CMD=RESCAN`（[command_spec.md](command_spec.md) §7.1） |
| `fault clear` | `FAULT`/`CH_FAULT`/`STATUS_HI.ERR` をクリア | `CMD=CLEAR_FAULT` |
| `mux reset` | TCA9548A リセットパルス→再初期化 | `CMD=MUX_RESET` |
| `stats clear` | 下流バス統計・ch別`READ_OK/READ_ERR`カウンタをクリア（上流ログ・カウンタとは別管理） | 上流レジスタに相当なし（USB診断専用の追加カウンタ） |
| `ch <0..5> enable` / `ch <0..5> disable` | `CH_ENABLE` の該当bitを変更（全ch無効化は拒否） | `CH_ENABLE`(0x47) 書込 |
| `ch <0..5> dir <0\|1>` | `DIR_CONFIG` の該当bitを設定し即時反映 | `DIR_CONFIG`(0x42) 書込, `APPLY_NOW`相当 |
| `reboot` | ウォッチドッグ経由の再起動（`SOFT_RESET`と同義） | `CMD=SOFT_RESET` |

USBシリアル経由の保守操作は、上流I2Cレジスタ経由の操作と**同一のFW内部機構**（コマンドメールボックス／`config.dirty`）を共有する。すなわちUSB側の`rescan`と上流側の`CMD=RESCAN`は同じ実行パスであり、二重定義にはならない（[software_architecture.md](software_architecture.md) §7.1）。

---

## 6. AS5600 強制制御コマンド（raw アクセス）

上流I2Cレジスタでは公開していない、AS5600の**任意レジスタへの直接読み書き**をUSBシリアルからのみ許可する。故障解析・製造時キャリブレーション確認・現場での応急調整を目的とする。

### 6.1 `ch <0..5> read <reg> [len]`

指定chのAS5600へ、指定レジスタから`len`バイト（既定1、最大8）を読み出す。Core1経由（下流バス排他）で実行され、通常巡回とインターリーブされる。

```
> ch 3 read 0x0C 2
OK sensor command queued
SENSOR_RESULT ch=3 op=read reg=0x0C ok=1 data=BC 0A
```

- 応答は非同期（`OK ... queued` の後、実行完了時に `SENSOR_RESULT` 行が出力される）。実行中に別の `ch read`/`ch write` を発行すると `ERR sensor diagnostic busy`（診断メールボックスの深さ0、[command_spec.md](command_spec.md) §7.1のCMDと同じ排他方針）。
- `reg` はAS5600データシート上のレジスタアドレス（0x00-0xFF）。詳細は [as5600_config.md](as5600_config.md)。

### 6.2 `ch <0..5> write <reg> <byte...>`

指定chのAS5600へ、指定レジスタから1-8バイトを直接書き込む。

```
> ch 1 write 0x07 0x0A 0x00
OK sensor command queued
SENSOR_RESULT ch=1 op=write reg=0x07 ok=1 data=-
```

**安全制約（確定）**：

| 制約 | 内容 | 理由 |
|------|------|------|
| BURN禁止 | `reg=0xFF`（BURN_ANGLE/BURN_SETTING相当）への書込は拒否し `ERR burn register blocked` | AS5600のOTP永久書込みを誤操作で実行させないため。データシート上OTPは書込回数制限あり不可逆（[as5600_config.md](as5600_config.md) §1） |
| CONF不整合の警告 | `reg=0x07/0x08`（CONF）へ直接書くと、ブリッジが管理する`config.as5600_conf`（[command_spec.md](command_spec.md) §4.8）と実デバイス値が一時的に不一致になり得る | 次回`cfg_apply_pending()`実行時（`AS5600_CONF`書込や再初期化時）に上書きされる。恒久的な変更をしたい場合は上流の`AS5600_CONF`(0x44/0x45)レジスタ経由（SF/FTHのみだが正規経路）を使うこと（README §「生センサ書き込みの注意」を継承） |
| 通常巡回との排他 | Core1の巡回ステートマシンの合間に割り込ませて実行（下流バスの同時アクセス防止） | バス競合・データ破損防止 |

### 6.3 用途の想定例

- 「AS5600の制御コマンドでコントロールできるようにします」の実体化：CONF（0x07/0x08）、STATUS(0x0B)、AGC(0x1A)、MAGNITUDE(0x1B/0x1C)、ZPOS/MPOS/MANG（0x01-0x06、角度範囲設定・本システムでは通常未使用）など、AS5600の全レジスタに対して読み書きが可能。
- 例：磁石アライメント作業時に `ch N read 0x0B 1` を連続実行してMD/ML/MHをリアルタイム確認（`monitor`と組み合わせるより高頻度に見たい場合の代替）。
- 例：フィルタ挙動の実機切り分けのため、通常経路（`AS5600_CONF`, SF/FTHのみ）では変更できないPM/HYST/OUTS等を一時的に直接書き換えて挙動確認（**恒久設定には使わない**、通常運用復帰時は`mux reset`または`reboot`でブリッジ既定値0x0A00に再初期化されることを確認して運用する）。

---

## 7. 実装アーキテクチャ（FW内部, 概要）

USBシリアル機能は [software_architecture.md](software_architecture.md) のモジュール構成に以下を追加する形で実装する：

| モジュール（追加） | コア | 責務 |
|---------------------|------|------|
| `usb_console` | Core0 | USB-CDC受信バイトのライン組立、コマンドパース、応答整形・送出。メインループのポーリングで駆動（ISR外） |
| `diag_mailbox` | 共有 | `ch read`/`ch write` をCore1へ依頼するロックフリーメールボックス（`CMD`メールボックスと同型：単一生産者Core0/単一消費者Core1、seq/ack） |
| `upstream_log` | 共有（Core0書込, usb_console読出） | 上流I2Cトランザクションの固定長リングバッファ（既定64件）。ISR内では記録のみ（配列書込）、シリアル出力はしない |
| `channel_diag` | 共有（Core1書込, usb_console読出） | ch別 READ_OK/READ_ERR カウンタ・最終成功/失敗時刻 |

`diag_mailbox` は §5/§6 の `rescan`/`mux reset`/`ch read`/`ch write` を Core1 の下流ポーリング状態機械（[software_architecture.md](software_architecture.md) §8.2）の合間に割り込ませる。通常巡回1周期（6ch巡回、目安 ~1ms）に対し、診断リクエストの割込みは平均1周期分の遅延で処理される想定（実測で確定）。

---

## 8. 6ch化（完了、2026-07-19）

`firmware_arduino/firmware_arduino.ino` は本書の6ch仕様に追従済み。3ch版プロトタイプからの主な変更点：

- `ch` コマンドの受理範囲：`0..2` → `0..5`
- 各種ビットマスク：`0x07` → `0x3F`（`CH_PRESENT`/`CH_ENABLE`/`DIR_CONFIG`/`STATUS_LO`/`CH_FAULT`, [command_spec.md](command_spec.md) §4.9/§4.1/§4.2/§4.6 に整合）
- `channels`/`status` の出力列：ch3-5分の行・カウンタを追加
- `STATUS`：1バイト→`STATUS_LO`(0x02)/`STATUS_HI`(0x03) 2バイト表示（[command_spec.md](command_spec.md) §4.1準拠）へ変更
- `FAULT`(0x04, mux/バス系)と`CH_FAULT`(0x05, ch別COMM)を分離し、`status`コマンドで両方を個別デコード表示
- レジスタオフセットをcommand_spec.md v1.0（`SAMPLE_COUNT`=0x08、`CH0_AGC`=0x30、`CONFIG`=0x40、`CH_PRESENT`=0x46、`CH_ENABLE`=0x47、`CMD`=0x50 等）へ全面移行、`VERSION`=0x10（major=1/minor=0）
- DIRピン：`kDir0..kDir2`（GP5-7）→ `kDir0..kDir5`（GP5-10の6本、[design_spec.md](design_spec.md) §6.4）
- `STATUS_HI.DATA_NEW`（任意実装, §4.1）を追加：直近publish以降のサンプル変化を`materializeRegs()`呼び出し単位で判定する簡易実装（上流I2Cの実トランザクション境界とは厳密には一致しない。詳細な同期は`firmware/`のFINISH/RECEIVE-ISRベース実装で対応予定）

`firmware/`（pico-sdkネイティブC実装）側は本インタフェース自体が未着手。移植時は本書を正としてCから実装する（Arduino版はUSBシリアル機能検証・6ch確定仕様の実装リファレンスという位置づけ）。

---

## 9. 確定事項 / 要確認

### 確定
- [x] USB-CDC・テキスト行プロトコル・115200 8N1 で確定（3ch版プロトタイプで動作実績あり）。
- [x] 監視系（`status`/`channels`/`config`/`monitor`/`master`/`log`）は6chへ拡張して踏襲（§4）。
- [x] 保守系（`rescan`/`fault clear`/`mux reset`/`stats clear`/`ch enable|disable`/`ch dir`/`reboot`）は上流`CMD`/設定レジスタと同一機構を共有（§5）。
- [x] AS5600 raw read/write（`ch read`/`ch write`）を追加、BURN(0xFF)書込禁止を確定（§6.2）。
- [x] 通常運用（上流応答・下流ポーリング）を阻害しない非ブロッキング設計（ISR外処理、Core1メールボックス経由）（§7）。
- [x] `firmware_arduino.ino` の6ch移植を実施（§8、2026-07-19）。

### 実装前に要確認（☐）
- [ ] 診断メールボックス（`ch read`/`ch write`）の下流巡回への割込み遅延の実測（通常巡回タイミング予算への影響、[i2c_architecture.md](i2c_architecture.md) §5.5との整合確認）。
- [ ] `firmware/`（pico-sdk版）への本インタフェース実装要否・優先度（現状ログ出力自体が[software_architecture.md](software_architecture.md) §14で未確定→本書により確定するため、pico-sdk版でも実装する方針で良いか）。
- [ ] USB-CDC無効ビルド時（ビルドオプションOFF, [software_architecture.md](software_architecture.md) §14）のGPIO/消費電力への影響確認。
- [ ] `STATUS_HI.DATA_NEW`の簡易実装（§8）の妥当性を実機・実運用で評価し、必要なら上流I2Cトランザクション境界に厳密同期する実装へ見直す。
