# Codex 実装プロンプト — robot_arm_monitor Phase 8〜10（ブロック中・着手不可）

## 位置づけ
本ファイルはPhase 8〜10の**予告**であり、そのままCodexへ渡して実装させるプロンプトでは
**ありません**。いずれのPhaseもPhase 6・7の完了が前提です
（`robot_arm_monitor/REQUIREMENTS.md` §9、`docs/design_spec.md` §8）。
着手可能になった時点で、本ファイルの該当セクションを土台に `CODEX_PROMPT_PHASE4.md`〜`PHASE7.md` と
同じ粒度の詳細プロンプトへ書き起こすこと。

**Phase 6（BLEアダプタ）・Phase 7（制御アプリIPC中継）は詳細プロンプトを作成済みです：**
[CODEX_PROMPT_PHASE6.md](CODEX_PROMPT_PHASE6.md)・[CODEX_PROMPT_PHASE7.md](CODEX_PROMPT_PHASE7.md)。
外部依存（`SteppingMotorDriver/firmware/BLE_WIFI_REQUIREMENTS.md`、`design/CONTROL_APP_REQUIREMENTS.md`）
の要求仕様自体は解消済みですが、ファームウェア側BLE実装・制御アプリ本体はまだ未着手のため、実機結合
確認はそれらの実装が進むまで限定的です（各詳細プロンプトの「前提条件」参照）。

前提：Phase 1〜7が完了していること。

---

## Phase 8: 統合ダッシュボード・ギア角度中継突合表示・全停止集約

**着手条件**：Phase 6・7完了。

- `device-manager.ts`の`RobotArmSnapshot`合成ロジック（動的軸数、`docs/design_spec.md` §4）
- F-RAM-DASH-01〜03（論理軸横断サマリー、軸詳細画面、基板単位ビュー）
- F-RAM-GEAR-01〜03（中継角度表示、bridge直接診断表示、静止中限定の突合判定・閾値1.0°）
- F-RAM-CTRL-05相当の全停止（ESTOP）集約ボタン

---

## Phase 9: トレンドグラフ統合・複数基板同時接続の総合確認

**着手条件**：Phase 8完了。

- `src/renderer/trend-charts.ts`（uPlot採用、`docs/design_spec.md` §7）
- 軸詳細画面：5チャートグループ（速度/位置・エンコーダ/偏差/電流・電圧/ギア角度、各最大4系列、F-RAM-GRAPH-01）
- 軸横断比較ビュー（メトリック選択式、最大12系列重畳、F-RAM-GRAPH-02）
- ダッシュボードはグラフを持たない（F-RAM-GRAPH-03）

---

## Phase 10: 最終パッケージ化

**着手条件**：Phase 1〜9完了。

- Phase 5の「bridge単独運用版パッケージ化」設定を土台に、SteppingMotorDriver対応を含めた
  最終版のパッケージ化を行う。
