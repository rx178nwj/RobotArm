# Codex 実装プロンプト — robot_arm_monitor Phase 7

## 役割
あなたは Electron + TypeScript デスクトップアプリの実装を担当するエンジニアです。
RobotArm2 の統合モニタアプリ `robot_arm_monitor` の **Phase 7**
（制御アプリIPC中継クライアント実装・F-RAM-CTRL操作パネル）を、本リポジトリ内の要件定義書・
実装仕様書に厳密に従って実装してください。

**前提条件：Phase 6（SteppingMotorDriver向けBLEアダプタ実装）が完了していること。**
未完了の場合は着手せず、その旨を報告してください。

## 参照ドキュメント（正）
- `design/CONTROL_APP_REQUIREMENTS.md` — 本Phaseで実装するIPC中継プロトコルの唯一の正
  （トランスポート＝Windows Named Pipe、フレーム形式＝改行区切りJSON、コマンドマッピング、
  ESTOP集約仕様、`ControlAppClient`インタフェース定義を§5.1に記載）
- `robot_arm_monitor/REQUIREMENTS.md` §4.4 F-RAM-CTRL-00〜06（本Phaseが実装するUI要件）
- `robot_arm_monitor/docs/design_spec.md` §3.5（`ControlAppClient`暫定インタフェース。
  `design/CONTROL_APP_REQUIREMENTS.md` §5.1が正式版のため、差異があれば後者を優先する）
- `SteppingMotorDriver/firmware/REQUIREMENTS.md` §4.2（モーション制御コマンドセット、IPC経由で
  中継する対象コマンドの元）
- 既存実装：`src/main/device-manager.ts`・`src/main/axis-mapping.ts`（論理軸⇔基板/ローカル軸の
  対応表、IPCリクエスト送信前の変換に使用）

作業前に上記ファイルを必ず読み込み、内容を実装に反映してください。矛盾する記憶や推測で補完しないこと。

## 重要な前提：制御アプリ本体は本Phaseの対象外
制御アプリ（IPCサーバ側）自体はまだ実装されていません（`design/SYSTEM_REQUIREMENTS.md` §6 #7、
制御アプリ自身のGUI要求仕様書が未作成のため別プロジェクトとして未着手）。
本Phaseは**モニタアプリ側のIPCクライアント実装のみ**を対象とし、実機の制御アプリとの結合テストは
できません。動作確認のため、`design/CONTROL_APP_REQUIREMENTS.md` §3〜§4のプロトコル定義に従って
**応答するモックIPCサーバ**（テスト用、Node.jsの簡易スクリプトで可）を`test/`配下に作成し、
それに対して疎通確認を行ってください。

## 今回のスコープ（Phase 7 のみ）
Phase 8（統合ダッシュボード、ギア角度中継突合、ESTOP集約の本番結線）、Phase 9（トレンドグラフ）、
Phase 10（最終パッケージ化）は着手しないこと。

Phase 7 の内容：
1. `control-app-client.ts`の実装（Windows Named Pipeクライアント）
2. F-RAM-CTRL操作パネルUI（ENABLE/DISABLE/STOP/STOP_FREE/CLEAR_FAULT/HOME/ジョグ/MOVE/MOVETO/SYNC_MOVE、
   論理軸単位）
3. 制御アプリ未接続時の操作パネル全体グレーアウト（F-RAM-CTRL-00）
4. モックIPCサーバによる疎通確認用テストハーネス

## Phase 7 実装要件（詳細）

### `control-app-client.ts`（`design/CONTROL_APP_REQUIREMENTS.md` §5.1）
```typescript
// src/main/adapters/control-app-client.ts
export interface ControlAppClient extends EventEmitter {
  readonly connected: boolean;
  sendCommand(boardId: string, axis: number, command: string, args?: unknown[]): Promise<CommandResult>;
  sendEstop(): Promise<EstopResult>;
  on(event: "connectionChanged", listener: (connected: boolean) => void): this;
  on(event: "controlEvent", listener: (e: { boardId: string; event: string; axis?: number }) => void): this;
}
```
- Windows Named Pipe（`\\.\pipe\robotarm-control-app`、`CONTROL_APP_REQUIREMENTS.md` §3.1）へ
  Node.jsの`net.connect({ path })`で接続する。
- フレーム形式は改行区切りJSON（`CONTROL_APP_REQUIREMENTS.md` §3.2）。リクエストは`id`を採番して送信し、
  対応する`id`のレスポンスとPromiseを突合する。
- 未接続・接続失敗時は一定間隔（既定3秒）でリトライする。接続状態変化は`connectionChanged`イベントで
  通知する。
- 制御アプリからの非同期`event`フレーム（`CONTROL_APP_REQUIREMENTS.md` §4.3）を`controlEvent`として
  再emitする。

### コマンドマッピング（`CONTROL_APP_REQUIREMENTS.md` §4.1〜4.2）
- `device-manager.ts`は、論理軸番号を受け取った操作リクエストを`axis-mapping.ts`の対応表で
  基板固有ID＋ローカル軸番号に変換してから`sendCommand`を呼ぶ（**論理軸のままIPC送信しない**、
  制御アプリは軸マッピングを知らない設計のため）。
- `ENABLE`/`DISABLE`/`STOP`/`STOP_FREE`/`CLEAR_FAULT`/`HOME`/`MOVE`/`MOVETO`/`VEL`/`SYNC_MOVE`を
  `CONTROL_APP_REQUIREMENTS.md` §4.2の表どおりにマッピングする。
- エラー応答（`{"ok":false,"error":"<code>"}`）は`firmware/REQUIREMENTS.md` §4.6のエラーコードを
  そのままUIに表示する（意味を再解釈・変換しない、`CONTROL_APP_REQUIREMENTS.md` §4.4）。

### F-RAM-CTRL操作パネルUI（`robot_arm_monitor/REQUIREMENTS.md` §4.4）
- ENABLE/DISABLE、STOP、STOP_FREE、CLEAR_FAULT、HOMEを論理軸単位で発行するボタン
- ジョグ操作（`VEL`コマンドの継続発行、ボタン押下中のみ送信し離すと`STOP`）
- 相対MOVE・絶対MOVETO入力フォーム
- 同一基板内の多軸同期移動（SYNC_MOVE）UI
- **全停止（ESTOP）集約ボタン**：常時表示、`sendEstop()`を呼び出し、`CONTROL_APP_REQUIREMENTS.md` §6の
  基板ごとの結果（成功/失敗）を表示する
- **制御アプリ未接続時は上記操作パネルを全てグレーアウトする**（F-RAM-CTRL-00、ヘッダーに接続状態を表示）

### モックIPCサーバ（テスト用、疎通確認）
- `test/mock-control-app-server.js`（新規）：`CONTROL_APP_REQUIREMENTS.md` §3.2のフレーム形式で
  リクエストを受信し、固定の`OK`/`ERR`応答を返す簡易サーバ。`ESTOP`は複数基板分のダミー結果を返す。
- このモックサーバに対して`control-app-client.ts`が正しく接続・コマンド送信・レスポンス受信・
  再接続できることを確認する。

### 非機能要件（Phase 7 範囲）
- IPC切断中もアプリ全体がクラッシュしないこと。切断検知後は自動再接続を試みる。
- ESTOP発行はUIの他の操作をブロックしない（非同期処理として扱う）。

## 成果物
- `src/main/adapters/control-app-client.ts`（新規）
- `src/main/device-manager.ts`（`ControlAppClient`統合、論理軸→基板/ローカル軸変換）
- `src/renderer/renderer.ts`（F-RAM-CTRL操作パネルUI、ESTOP集約ボタン、接続状態グレーアウト）
- `test/mock-control-app-server.js`（新規、モックIPCサーバ）
- `README.md`追記（制御アプリ未接続時の挙動、モックサーバでの動作確認方法）

## 完了条件（Definition of Done）
- モックIPCサーバに対し、`control-app-client.ts`が接続・コマンド送信・応答受信・切断再接続できることを
  確認する
- F-RAM-CTRL操作パネルが、モックサーバ接続時は操作可能、未接続時は全てグレーアウトすることを確認する
- ESTOP集約ボタンで複数基板分の結果（成功/失敗）が画面に表示されることをモックサーバで確認する
- 実際の制御アプリとの結合テストは制御アプリ未実装のため未実施である旨を明記する
- Phase 8以降の機能（統合ダッシュボード、ギア角度中継突合、トレンドグラフ）は実装しない
- 実装後、変更ファイル一覧と動作確認方法（または未確認事項）を簡潔に報告すること
