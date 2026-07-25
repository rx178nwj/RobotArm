# Codex 実装プロンプト — robot_arm_monitor Phase 1

## 役割
あなたは Electron + TypeScript デスクトップアプリの実装を担当するエンジニアです。
RobotArm2 の複数基板（SteppingMotorDriver、multi_i2c_bridge）を横断監視する統合モニタアプリ
`robot_arm_monitor` を、本リポジトリ内の要件定義書・実装仕様書に厳密に従って実装してください。

## 参照ドキュメント（正）
- `design/SYSTEM_REQUIREMENTS.md` — システム横断の要求仕様書（トポロジー・通信アーキテクチャ・軸マッピング規約の唯一の正）
- `robot_arm_monitor/REQUIREMENTS.md` — 本アプリの要求仕様書（唯一の正）
- `robot_arm_monitor/docs/design_spec.md` — 本アプリの実装仕様書（アーキテクチャ・データモデルの唯一の正）
- `multi_i2c_bridge/docs/usb_serial_spec.md` — multi_i2c_bridgeとのUSBシリアル通信プロトコルの唯一の正。
  コマンド文字列・応答フォーマットをそのまま実装すること。本アプリ側でコマンドを変更・拡張しない。
- `multi_i2c_bridge/monitor_app/src/main/device-session.ts`・`parser.ts`・`port-identity.ts` — 移植元の既存実装

作業前に上記ファイルを必ず読み込み、内容を実装に反映してください。矛盾する記憶や推測で補完しないこと。

## 今回のスコープ（Phase 1 のみ）
`robot_arm_monitor/REQUIREMENTS.md` §9 のロードマップに従い、**Phase 1 のみ**を実装してください。
Phase 2 以降（軸マッピング設定UI、統合ダッシュボード、ギア角度突合、トレンドグラフ、パラメータ設定、ログ記録、
bridge保守コマンドGUI化、パッケージ化）は着手しないこと。

**SteppingMotorDriver向けの実装（BLEアダプタ、`ControlAppClient`）は本Phaseの対象外**です。
`design/SYSTEM_REQUIREMENTS.md` §6 #1・#2 の外部依存（ファームウェアBLE GATTサービス未実装、制御アプリ・IPC未設計）
が解消するまで着手できないため、依存のない multi_i2c_bridge 系統のみを実装してください。

Phase 1 の内容：
1. Electron + TypeScript プロジェクトの雛形作成
2. `DeviceAdapter` 共通インタフェースの定義（種別混在を見据えた設計だが、Phase 1 では `multi_i2c_bridge` 種別のみ実装）
3. `multi-i2c-bridge-adapter.ts` の実装（既存 `multi_i2c_bridge/monitor_app` のロジック移植）
4. 単一 multi_i2c_bridge デバイスとの USB-CDC 接続・`identity` による疎通確認・単体接続確認

## 確定済みの技術方針（変更しないこと）
| 項目 | 採用 | 参照 |
|------|------|------|
| フレームワーク | Electron | design_spec.md §1 |
| 言語 | TypeScript（`tsc` ビルド + `electron .`。`multi_i2c_bridge/monitor_app` と同じビルド方式） | design_spec.md §1 |
| メインプロセス | Node.js + `serialport`。シリアル I/O はメインプロセスに集約し、レンダラーは IPC 経由でのみ操作 | design_spec.md §1 |
| レンダラー | Phase 1 では最小限（ポート一覧・接続操作・生ログ表示のみ）。ダッシュボードUIはPhase 3以降 | design_spec.md §6 |
| グラフ描画ライブラリ | uPlot（Phase 5 まで未使用。Phase 1 では導入不要） | REQUIREMENTS.md §4.6 |
| 設定永続化 | `electron-store`（Phase 2 の軸マッピングまで未使用。Phase 1 では導入不要） | design_spec.md §5 |
| パッケージ化 | 行わない。`npm start`（`tsc` ビルド後 `electron .`）による開発機直接実行のみ | REQUIREMENTS.md §8 #6 |
| ボーレート | 115200 bps 固定 | usb_serial_spec.md §2 |
| bridgeポーリング周期 | 100ms（`monitor` コマンド受理下限。REQUIREMENTS.md F-RAM-GEAR-05で確定した値だが、Phase 1では単発`identity`/`status`確認まででよく、`monitor`常時起動は必須ではない） | REQUIREMENTS.md F-RAM-GEAR-05 |

## Phase 1 実装要件（詳細）

### `DeviceAdapter` 共通インタフェース（design_spec.md §3.1）
```typescript
// src/main/adapters/device-adapter.ts
export type DeviceKind = "stepping_motor_driver" | "multi_i2c_bridge";

export interface DeviceIdentity {
  kind: DeviceKind;
  boardId: string;
  protocolVersion?: string;
}

export interface DeviceAdapter extends EventEmitter {
  readonly kind: DeviceKind;
  readonly boardId: string;
  connect(path: string, periodMs: number): Promise<void>;
  disconnect(): void;
  sendCommand(command: string): void;
  // "update" イベントで正規化スナップショットを emit する
}
```
- `DeviceKind` は将来の `stepping_motor_driver` を型として残すが、Phase 1 ではアダプタ実装を作らない（未実装のまま型のみ定義）。
- VID一次分類（`2e8a` = multi_i2c_bridge候補、design_spec.md §3.1の`VID_HINT`）を実装し、`serialport.list()` の結果から候補ポートを判別する。

### `multi-i2c-bridge-adapter.ts`（design_spec.md §3.3）
- `multi_i2c_bridge/monitor_app/src/main/device-session.ts` の `DeviceSession` クラス（`EventEmitter` 継承、`connect`/`startMonitor`/`stopMonitor`/`disconnect`/`emitUpdate` 構成）を移植し、`DeviceAdapter` インタフェースに適合させる。
- `parser.ts`（行パーサ）・`port-identity.ts`（`identity`コマンドによる基板固有ID判別）も同様に移植する。行パーサ・コマンド組み立てロジックは変更しないこと（usb_serial_spec.md準拠）。
- 識別：`identity` コマンドの応答（`IDENTITY product=multi_i2c_bridge id=<16hex> protocol=1`）を検証し、`multi_i2c_bridge` 製品であることを確認してから接続を確定する（VID/PIDだけで確定しない、REQUIREMENTS.md F-RAM-CONN-01）。

### デバイス管理・接続フロー（Phase 1 範囲）
- 起動時にシリアルポート一覧を列挙し、`VID_HINT` で候補をリストアップする（レンダラーに表示）。
- ユーザーが候補ポートを選択して「接続」操作を行うと、`identity` による疎通確認 → 確認後に `status`（単発）を送信し初期状態を取得する。
- 自動全接続はしない（REQUIREMENTS.md F-RAM-CONN-01、既存2アプリの方針を踏襲）。
- 複数デバイスの同時接続・軸マッピングはPhase 1では実装しない（単一デバイスの接続確認まで）。

### 送受信ログ（デバッグ用）
- 送受信した生コマンド・応答を時刻付きでレンダラー画面に一覧表示するデバッグパネルを設ける（開閉不要、Phase 1 では常時表示で可）。

### アーキテクチャ制約
- Electron のセキュリティベストプラクティスに従うこと：
  - `contextIsolation: true`、`nodeIntegration: false`
  - `preload.ts` で `contextBridge` を使い、IPC 経由の限定APIのみレンダラーに公開する
  - シリアルポートへの直接アクセスをレンダラーに渡さない
- `DeviceAdapter` インタフェースを介した設計とし、将来の `stepping-motor-ble-adapter.ts` 追加時に `device-manager.ts` や renderer 側へ影響が及ばない構造にすること（design_spec.md §9.1）。

### 非機能要件（Phase 1 範囲）
- シリアル通信タイムアウトやパースエラーでアプリ全体がクラッシュしないこと
- 接続失敗時は当該操作 UI が分かる形でエラー表示する
- Ubuntu対応は行わない（Windows 10/11のみ、REQUIREMENTS.md §5）

## 成果物
- `package.json`（`electron`, `serialport`, `@serialport/parser-readline`, `typescript`, `@types/node` を依存関係に追加。`build`/`start`スクリプトを定義、`multi_i2c_bridge/monitor_app/package.json`のパターンを踏襲）
- `tsconfig.json`
- `src/main/main.ts`（BrowserWindow 生成、IPCハンドラ登録、ポート列挙）
- `src/main/adapters/device-adapter.ts`（共通インタフェース、`VID_HINT`）
- `src/main/adapters/multi-i2c-bridge-adapter.ts`・`parser.ts`・`port-identity.ts`（移植）
- `src/main/preload.ts`（contextBridge 経由の限定API公開）
- `src/renderer/index.html` / `renderer.ts` / 最小限の CSS（ポート一覧・接続操作・生ログ表示）
- `src/shared/types.ts`（`multi_i2c_bridge/monitor_app/src/shared/types.ts` 相当を移植）
- 簡単な `README.md` 追記（起動方法: `npm install` → `npm start`）

## 完了条件（Definition of Done）
- `npm install && npm start` でアプリが起動する
- シリアルポート一覧が表示され、`2e8a`系VIDの候補ポートが判別・選択→接続操作ができる（実機が無い場合はコード上の到達可能性を確認し、その旨を報告する）
- `identity` → `status` のシーケンスが実装されており、送受信ログがレンダラーに表示される
- Phase 2 以降の機能（軸マッピング、ダッシュボード、グラフ、パラメータ設定、ログ記録、SteppingMotorDriver対応）は実装しない
- 実装後、変更ファイル一覧と動作確認方法（または未確認事項）を簡潔に報告すること
