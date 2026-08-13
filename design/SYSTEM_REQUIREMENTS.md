# RobotArm2 システム要求仕様書（マスター）

RobotArm2 を構成する全サブシステム（ファームウェア・回路・PCアプリ）の要求仕様書を束ね、
どのサブシステムにも一意に属さない**システム横断の決定事項**（トポロジー、通信アーキテクチャ、
軸マッピング規約）を集約するマスタードキュメント。各サブシステムの詳細仕様はここでは再定義せず、
それぞれの要求仕様書を正とする（§2）。

| 項目 | 内容 |
|------|------|
| 対象 | RobotArm2 全体（ロボットアーム本体・制御系・監視系） |
| 正となる接続構成図 | [IF_design.drawio](IF_design.drawio) |
| 版 | 0.1（初版、[robot_arm_monitor/REQUIREMENTS.md](../robot_arm_monitor/REQUIREMENTS.md) §7 の内容を移管して新設） |
| 作成日 | 2026-07-25 |

---

## 1. システム概要

RobotArm2 は、複数の**SteppingMotorDriver基板**（モーション制御）と**multi_i2c_bridge基板**（ギア出力角度センシング）で各関節を駆動・監視するロボットアームであり、PC側には**制御アプリ**（モーション制御専用）と**モニタアプリ**（監視専用、`robot_arm_monitor`）の2アプリが存在する。

関節数・基板数は固定ではなく、[IF_design.drawio](IF_design.drawio) の接続構成図を正として拡張していく（§3）。個々の関節の呼称（J1、J2…）はユーザー設定によるラベルであり、システム内部では固定enumとして扱わない（§5）。

---

## 2. サブシステム構成・要求仕様書一覧

| サブシステム | 役割 | 要求仕様書（正） | 実装状況 |
|-------------|------|------------------|----------|
| SteppingMotorDriverファームウェア | ESP32-S3、3軸モーション制御 | [SteppingMotorDriver/firmware/REQUIREMENTS.md](../SteppingMotorDriver/firmware/REQUIREMENTS.md) | Phase1〜5実装済み（[CLAUDE.md](../SteppingMotorDriver/CLAUDE.md)） |
| SteppingMotorDriver ギア角度モニタ機能 | multi_i2c_bridge経由のギア出力角度中継 | [GEAR_ANGLE_MONITOR_REQUIREMENTS.md](../SteppingMotorDriver/firmware/GEAR_ANGLE_MONITOR_REQUIREMENTS.md) | Phase6案、未着手 |
| SteppingMotorDriver BLE・WiFi通信 | 読み取り専用テレメトリ（2026-08-09以降、robot_arm_monitorはUSB-CDC経由に移行済みで本経路を使用しない。将来の別クライアント向けに恒久維持、§4） | [BLE_WIFI_REQUIREMENTS.md](../SteppingMotorDriver/firmware/BLE_WIFI_REQUIREMENTS.md) | 要件定義済み（Phase1〜5未着手） |
| SteppingMotorDriver monitor_app | 単体デバッグ用Electronアプリ（USB-CDC） | [SteppingMotorDriver/monitor_app/REQUIREMENTS.md](../SteppingMotorDriver/monitor_app/REQUIREMENTS.md) | Phase3まで実装済み |
| multi_i2c_bridgeファームウェア・回路 | RP2040、AS5600×6ch集約ブリッジ | [multi_i2c_bridge/docs/design_spec.md](../multi_i2c_bridge/docs/design_spec.md)、[command_spec.md](../multi_i2c_bridge/docs/command_spec.md) | 6ch版実装済み |
| multi_i2c_bridge USBシリアル診断IF | 監視・保守・強制制御コマンド | [multi_i2c_bridge/docs/usb_serial_spec.md](../multi_i2c_bridge/docs/usb_serial_spec.md) | 実装済み |
| multi_i2c_bridge monitor_app | 単体デバッグ用Electronアプリ（USB-CDC） | [multi_i2c_bridge/docs/monitor_app_spec.md](../multi_i2c_bridge/docs/monitor_app_spec.md) | 部分実装 |
| robot_arm_monitor | 統合監視アプリ（本書§4の役割分担を実装） | [robot_arm_monitor/REQUIREMENTS.md](../robot_arm_monitor/REQUIREMENTS.md)、[docs/design_spec.md](../robot_arm_monitor/docs/design_spec.md) | 未実装（Phase1〜5は依存なく着手可、Phase6以降は本書§6の外部依存待ち） |
| 制御アプリ | モーション制御専用アプリ（USB専有） | [design/CONTROL_APP_REQUIREMENTS.md](CONTROL_APP_REQUIREMENTS.md)（IPC中継プロトコルのみ確定。GUI・USB接続管理UX等は未作成、同書§8 #1） | 未着手（IPCプロトコル確定、実装は未着手） |

---

## 3. システムトポロジー（確定、[IF_design.drawio](IF_design.drawio)を正とする）

```
                          モニター/制御 PC
        ┌───────────────────────────────────────────────────┐
        │   モニタアプリ（robot_arm_monitor）   制御アプリ（別アプリ）  │
        └──────┬───────────────┬────ローカルIPC────┬─────────┘
               │USB(診断)       │(コマンド+テレメトリ)│USB(制御+テレメトリ, 専有)
               ▼               └────────────────────►
       multi_i2c_bridge0-2   SteppingMotorDriver0-2
               │ I2C                    │
               ▼                        ▼
       angle sensor ×3/枚         Stepping Mtor ×3/枚
```

- **現行の基板構成はSteppingMotorDriver×3 + multi_i2c_bridge×3（9軸相当）**。将来**最大4+4（12軸相当）まで拡張予定**。
- **bridge:SteppingMotorDriverは1:1ペアリング**：I2Cバス（GPIO38/39、SteppingMotorDriver側マスタ）は1台のbridgeを1台のSteppingMotorDriverにのみ物理接続する（[GEAR_ANGLE_MONITOR_REQUIREMENTS.md §2.2/§3.2](../SteppingMotorDriver/firmware/GEAR_ANGLE_MONITOR_REQUIREMENTS.md)）。
- デバイス数の上限自体は設けない設計とするが、UIやIPCデータモデルは当面3+3、将来4+4を基準に設計する（[robot_arm_monitor/REQUIREMENTS.md §3](../robot_arm_monitor/REQUIREMENTS.md)）。

---

## 4. 通信アーキテクチャ方針（サブシステム横断の決定事項、確定）

SteppingMotorDriverへは、モニタアプリ・制御アプリの2プロセスがアクセスする必要があるが、OSのシリアルポートは1プロセスしか排他オープンできない。**USB通信ブリッジ（ブローカー）プロセスによるポート共有は検討の末に撤回**し、[IF_design.drawio](IF_design.drawio) のとおり**アプリごとにトランスポート自体を分離する**方式を採用する。

| 接続 | トランスポート | 役割 |
|------|----------------|------|
| 制御アプリ ⇔ SteppingMotorDriver | **USB-CDC（専有）** | ENABLE/MOVE/JOG/HOME等のモーション制御コマンド、および状態取得（`GET`系コマンド）によるテレメトリポーリング。低遅延・低ジッタが必要な実通信経路（無線はリアルタイム性のリスク要因のため制御コマンドには使わない） |
| モニタアプリ ⇔ SteppingMotorDriver | **直接接続なし** | モニタアプリはSteppingMotorDriverへの直接接続（USB/BLEいずれも）を持たない。テレメトリは制御アプリのローカルIPC中継のみを経由する（下記） |
| モニタアプリ ⇔ multi_i2c_bridge | **USB（直接）** | bridgeの診断コマンド（`status`/`channels`/`master`/`log`等、読み取り中心） |
| SteppingMotorDriver ⇔ multi_i2c_bridge | I2C（GPIO38/39、既存確定仕様） | ギア出力角度中継（[GEAR_ANGLE_MONITOR_REQUIREMENTS.md](../SteppingMotorDriver/firmware/GEAR_ANGLE_MONITOR_REQUIREMENTS.md)） |
| モニタアプリ ⇔ 制御アプリ | ローカルIPC（Windows Named Pipe、[CONTROL_APP_REQUIREMENTS.md](CONTROL_APP_REQUIREMENTS.md)） | モニタアプリのモーション制御パネルからのコマンド中継、および制御アプリがUSB-CDC経由でポーリングしたSteppingMotorDriverテレメトリの中継 |

- **2026-08-09、モニタアプリのSteppingMotorDriverテレメトリ取得経路をBluetooth（読み取り専用）からUSB-CDC（制御アプリ経由のIPC中継）へ変更**（§7決定ログ参照）。SteppingMotorDriverファームウェアのBLE/WiFiテレメトリ機能自体（[BLE_WIFI_REQUIREMENTS.md](../SteppingMotorDriver/firmware/BLE_WIFI_REQUIREMENTS.md)）は恒久方針として維持し、将来の別用途（他クライアントからの読み取り等）に残す。
- **WiFiは今後追加実装する**（今回のスコープには含めないが撤回ではない）。用途は導入時期が来た時点で別途要件化する。
- 無線（Bluetooth/将来のWiFi）はいずれも**読み取り専用**の方針を維持する。モーション制御コマンドの直接発行には使わない。
- **モニタアプリからのモーション制御操作（ENABLE/MOVE/JOG等、ESTOP含む）は、すべて制御アプリへのIPC中継を経由する**（モニタアプリ自身はSteppingMotorDriverへ書き込みコマンドを発行しない）。制御アプリが未起動・無応答の場合、モニタアプリからの操作（ESTOPを含む）は実行できない。**これは恒久的な残存安全リスクとして記録する**（無線への書き込み例外は設けない方針のため、§6参照）。

---

## 5. 軸マッピング規約

論理軸（関節）は固定の「J1〜J6」のような決め打ちenumではなく、**接続された基板構成に応じて動的に決まる論理軸リスト**として扱う。

- 論理軸番号は基板構成（SteppingMotorDriver×N、multi_i2c_bridge×N、各3ローカル軸/ch）から動的に導出し、上限は12軸（4基板×3軸）とする。
- 表示名（「J1」「J2」等、実際のロボットアーム関節名との対応）はユーザーが自由に設定するラベルであり、システム内部の識別キーにはしない（識別は基板固有ID＋ローカル軸/ch番号を用いる）。
- この規約は `robot_arm_monitor` に限らず、将来 制御アプリ 等が軸を扱う際にも共通で用いる想定とする。

---

## 6. 未解決事項（システム全体、外部依存）

以下はいずれかの単一サブシステムの要求仕様書には収まらない、システム横断の未解決事項。

| # | 項目 | 優先度 | 影響先 |
|---|------|--------|--------|
| ~~1~~ | ~~SteppingMotorDriverファームウェアへのBLEテレメトリサービス未実装~~（解決済み：[BLE_WIFI_REQUIREMENTS.md](../SteppingMotorDriver/firmware/BLE_WIFI_REQUIREMENTS.md) §4 でGATTサービス・キャラクタリスティック（Device Info/Axis Status/Power/Fault Info/Gear Angle、既存USBコマンドのJSON構造を転用）を確定。実装は未着手（同書§10 Phase1〜2）） | ~~High~~ | robot_arm_monitor（Phase6ブロッカー、要件定義完了により着手可能） |
| ~~2~~ | ~~制御アプリ本体・モニタアプリとのIPC中継プロトコル未設計~~（解決済み：[design/CONTROL_APP_REQUIREMENTS.md](CONTROL_APP_REQUIREMENTS.md)でWindows Named Pipe・改行区切りJSON・基板固有ID＋ローカル軸番号でのコマンドマッピング・ESTOP集約仕様を確定。制御アプリ自身のGUI要求仕様書は同書§8 #1として別途未解決） | ~~High~~ | robot_arm_monitor（Phase7ブロッカー解消、実装は未着手） |
| ~~3~~ | ~~Bluetoothデバイス検出・ペアリングのUX未検討~~（解決済み：[BLE_WIFI_REQUIREMENTS.md](../SteppingMotorDriver/firmware/BLE_WIFI_REQUIREMENTS.md) §4.2/§4.4 でAdvertising名`SMD-<board_id>`によるUSB VID一次分類相当の識別、LE Secure Connections + Just Works + ボンディングによるペアリング方式を確定） | ~~Medium~~ | robot_arm_monitor |
| ~~4~~ | ~~WiFi追加実装の時期・用途未定~~（解決済み：[BLE_WIFI_REQUIREMENTS.md](../SteppingMotorDriver/firmware/BLE_WIFI_REQUIREMENTS.md) §5 で用途を「BLEの代替・追加の高帯域テレメトリ経路」に確定。SSID/パスワードはUSB-CDC経由でプロビジョニング。実装は未着手（同書§10 Phase3〜4）） | ~~Low~~ | 全体 |
| 5 | **残存安全リスク**：ESTOPが制御アプリへの中継経路のみを通るため、制御アプリが未起動・無応答の場合はモニタアプリからのESTOPも実行できない（§4で確定した仕様上の制約。無線への例外は設けない方針のため恒久的に残る） | High | robot_arm_monitor、制御アプリ、安全設計全体 |
| 6 | 軸マッピングの上限12軸（4基板×3軸）が実際の将来要件と一致するか | Low | 全体 |
| 7 | 制御アプリ自身の要求仕様書（GUI構成、USB接続管理UX、パラメータ設定範囲）が未作成 | High | 制御アプリ（[CONTROL_APP_REQUIREMENTS.md](CONTROL_APP_REQUIREMENTS.md) §8 #1、IPC中継プロトコルとは別に必要） |

各サブシステム固有の未解決事項は、それぞれの要求仕様書（§2）を参照。

---

## 7. 決定ログ

| 日付 | 決定内容 |
|------|---------|
| 2026-07-25 | `robot_arm_monitor`（統合モニタアプリ）の新設を決定。SteppingMotorDriver・multi_i2c_bridgeの既存単体アプリとは別に新規プロジェクトとして開始 |
| 2026-07-25 | bridge:SteppingMotorDriverの1:1ペアリング、種別混在ポート自動判別（VID一次分類）を確定 |
| 2026-07-25 | ギア角度突合判定は静止中限定・閾値1.0°、グラフ表示は系列数を絞ったレイアウトで確定 |
| 2026-07-25 | USB通信ブリッジ（ブローカー）方式を検討したが撤回。[IF_design.drawio](IF_design.drawio) の確定により、制御アプリ=USB専有・モニタアプリ=Bluetooth（読取専用）+USB(bridge直接) のトランスポート分離方式へ変更 |
| 2026-07-25 | 基板構成を2+2から3+3（現行）・将来最大4+4へ更新。軸マッピングを固定J1〜J6から動的な論理軸リスト（最大12軸）へ一般化 |
| 2026-07-25 | モニタアプリのモーション制御操作は制御アプリへのIPC中継方式に確定。ESTOPも同経路のみを通ることを確定し、残存安全リスクとして記録 |
| 2026-07-25 | システム横断の要求仕様（本書）を新設し、[robot_arm_monitor/REQUIREMENTS.md](../robot_arm_monitor/REQUIREMENTS.md) §7 の内容を移管 |
| 2026-07-25 | SteppingMotorDriverのBLE・WiFi通信要件を新設（[BLE_WIFI_REQUIREMENTS.md](../SteppingMotorDriver/firmware/BLE_WIFI_REQUIREMENTS.md)）。GATTサービス構成（既存USBコマンドのJSON構造を転用）、ペアリング方式（Just Works+ボンディング）、WiFi用途（BLE代替の高帯域テレメトリ、USB-CDC経由プロビジョニング）を確定し、§6 #1/#3/#4をクローズ |
| 2026-08-01 | multi_i2c_bridgeに0位置設定機能（磁石取付誤差の補正）を追加。ch毎に現在位置を0degとして設定するコマンド（上流I2C `CMD=ZERO_SET`/USBシリアル`ch zero set`）と、オフセットのEEPROM永続化を要件化し、Arduino版ファームウェアへ実装（[multi_i2c_bridge/docs/design_spec.md](../multi_i2c_bridge/docs/design_spec.md) §5.5、[command_spec.md](../multi_i2c_bridge/docs/command_spec.md) §4.10） |
| 2026-08-01 | SteppingMotorDriverに、multi_i2c_bridgeの0位置設定を発行する`SET GEAR_ZERO`/`GEAR_ZERO_CLEAR`コマンドを追加（[GEAR_ANGLE_MONITOR_REQUIREMENTS.md F-GEAR-10](../SteppingMotorDriver/firmware/GEAR_ANGLE_MONITOR_REQUIREMENTS.md)）。BLE/WiFi経由での発行案を検討したが、§4の恒久方針（BLE/WiFiは読み取り専用・書き込みコマンド恒久対象外）を維持することを確認し、**USB-CDC（制御アプリ）限定**で確定。BLE/WiFiは較正状態の参照（`zero_calibrated`）のみ追加（[BLE_WIFI_REQUIREMENTS.md](../SteppingMotorDriver/firmware/BLE_WIFI_REQUIREMENTS.md) §1.3/§4.1） |
| 2026-07-26 | 制御アプリ・モニタアプリのIPC中継プロトコルを新設（[CONTROL_APP_REQUIREMENTS.md](CONTROL_APP_REQUIREMENTS.md)）。Windows Named Pipe・改行区切りJSON、基板固有ID＋ローカル軸番号でのコマンドアドレス指定、ESTOP集約の並行発行方式を確定し、§6 #2をクローズ。制御アプリ自身のGUI要求仕様書は新たな未解決事項（§6 #7）として記録 |
| 2026-08-01 | robot_arm_monitorのbridge保守コマンドGUIに0位置設定（`ch <0..5> zero set/clear`）を追加。チャンネルカードにボタンを追加し、`channel_zero_set`実行時のみ確認ダイアログを表示（[robot_arm_monitor/REQUIREMENTS.md F-RAM-GEAR-04](../robot_arm_monitor/REQUIREMENTS.md)） |
| 2026-08-02 | multi_i2c_bridgeに0位置設定後の角度確認用USBコマンド`ch <0..5> angle`を要件化（[usb_serial_spec.md §4.8](../multi_i2c_bridge/docs/usb_serial_spec.md)、ファームウェア未実装）。robot_arm_monitorにも対応する参照機能（チャンネルカードでの角度即時表示）を要件化（[robot_arm_monitor/REQUIREMENTS.md F-RAM-GEAR-04](../robot_arm_monitor/REQUIREMENTS.md)、いずれも未実装） |
| 2026-08-09 | §4のBluetooth（読み取り専用）方式を撤回し、モニタアプリのSteppingMotorDriverテレメトリ取得経路をUSB-CDC（制御アプリ経由のローカルIPC中継）へ変更。制御アプリがUSB-CDCの既存`GET`系コマンド（`GET STATE`/`GET POS`/`GET VEL`/`GET ENC`/`GET ADC`/`GET FAULT_INFO`/`GET POS_DEG`/`GET ENC_DEG`/`GET POT_DEG`/`GET GEAR_STATUS`）を周期ポーリングし、既存IPCプロトコル（[CONTROL_APP_REQUIREMENTS.md](CONTROL_APP_REQUIREMENTS.md)）に新設した`telemetry`フレームでモニタアプリへ中継する（同書§4.3改訂）。ファームウェア側のBLE/WiFiテレメトリ機能自体は変更せず恒久方針として維持し、robot_arm_monitorの`stepping-motor-ble-adapter.ts`（BLE central実装）は削除した |
