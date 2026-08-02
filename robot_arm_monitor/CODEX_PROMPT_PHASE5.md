# Codex 実装プロンプト — robot_arm_monitor Phase 5

## 役割
あなたは Electron + TypeScript デスクトップアプリの実装を担当するエンジニアです。
RobotArm2 の統合モニタアプリ `robot_arm_monitor` の **Phase 5**
（bridge単独運用版としてのパッケージ化）を、本リポジトリ内の要件定義書・実装仕様書に
厳密に従って実装してください。

**前提条件：Phase 4（bridgeパラメータ設定画面・CSVログ記録）が完了していること。**
未完了の場合は本Phaseに着手せず、その旨を報告してください。

## 参照ドキュメント（正）
- `robot_arm_monitor/REQUIREMENTS.md` §9（開発ロードマップ Phase 5）・§8 未解決事項#6
  （パッケージ化方針：機能実装完了後にパッケージ化、開発中は`npm start`運用）
- `robot_arm_monitor/docs/design_spec.md` §8（実装ロードマップ Phase 5）
- 既存の`package.json`・`tsconfig.json`（現在の依存関係・ビルドスクリプト構成）

## 今回のスコープ（Phase 5 のみ）
Phase 6以降（SteppingMotorDriver向けBLEアダプタ、制御アプリIPC、統合ダッシュボード、
ギア角度中継突合、トレンドグラフ、最終パッケージ化）は着手しないこと。
本Phaseは**bridge単独運用版としての区切り**のパッケージ化であり、最終パッケージ化（Phase 10）
とは別物であることに注意する（Phase 6以降でSteppingMotorDriver対応が追加された後、
Phase 10で改めてパッケージ化を行う前提）。

Phase 5 の内容：
1. `electron-builder`（または同等ツール）の導入とWindows向けビルド設定
2. 配布可能なインストーラ/実行ファイル一式の生成確認
3. アプリアイコン・製品名・バージョン情報等のメタデータ整備

## Phase 5 実装要件（詳細）

### ビルドツール選定
- `electron-builder`を採用する（`SteppingMotorDriver/monitor_app`・`multi_i2c_bridge/monitor_app`で
  既にパッケージ化実績がある場合はその設定を参考にする。無ければ`electron-builder`のWindows向け
  標準構成（NSIS installer）で新規導入する）。
- 既存2アプリの`package.json`にパッケージ化設定がある場合は、必ず先に読み込んでから
  本アプリ向けに適用すること（差異があれば理由を明記する）。

### `package.json`への追加
- `build`セクション（`electron-builder`設定）：`appId`、`productName`（"Robot Arm Monitor"）、
  `win.target`（`nsis`）、`files`（`dist/`・`node_modules/`等の配布対象範囲）
- スクリプト追加：`"dist": "npm run build && electron-builder"`（既存の`build`＝`tsc`ビルドは変更しない）
- devDependencies追加：`electron-builder`

### 対象OS
- Windows 10/11のみ（`REQUIREMENTS.md` §5、Ubuntu/macOS対応は範囲外）。`win.target`を`nsis`
  （インストーラ形式）とする。既存2アプリが`portable`等の別形式を採用している場合はそちらに合わせてよいが、
  理由を報告に含めること。

### 除外・注意事項
- `serialport`ネイティブモジュールを含むため、`electron-builder`の`node-gyp`リビルド設定
  （`npm run postinstall`での`electron-rebuild`、または`electron-builder`の`nodeGypRebuild`）が
  必要かどうかを確認し、既存2アプリの対応方法を踏襲する。
- パッケージ化対象に開発用ファイル（`test/`、ソースの`.ts`、`docs/`等）を含めない（`files`設定で除外）。

### 非機能要件（Phase 5 範囲）
- `npm run dist`実行で配布物（インストーラ）が生成できること。
- 生成物のインストール・起動確認は実機（開発機）で可能な範囲で行い、できない場合はビルド成功までを
  確認範囲とし、その旨を報告する。

## 成果物
- `package.json`（`build`セクション、`dist`スクリプト、`electron-builder`依存追加）
- 必要に応じて`build/`（アイコン等のリソース）ディレクトリ新規作成
- `README.md`追記（パッケージ化・配布物生成方法：`npm run dist`）

## 完了条件（Definition of Done）
- `npm run dist`でWindows向け配布物（インストーラまたはポータブル実行ファイル）が生成される
- 生成された実行ファイルの起動確認（可能な範囲で）、または未確認事項の報告
- Phase 6以降の機能（SteppingMotorDriver対応、統合ダッシュボード等）・最終パッケージ化（Phase 10）は
  対象外である旨を明記する
- 実装後、変更ファイル一覧と動作確認方法（または未確認事項）を簡潔に報告すること
