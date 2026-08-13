# Codex 実装プロンプト一覧

`robot_arm_monitor/REQUIREMENTS.md` §9・`docs/design_spec.md` §8 のロードマップに対応する、
Phaseごとの実装プロンプト一覧。各Phaseは前のPhaseの完了を前提とする。

| Phase | プロンプト | 状態 |
|-------|-----------|------|
| 1 | [CODEX_PROMPT.md](CODEX_PROMPT.md) | 実装済み |
| 2 | （Phase 1完了後、個別プロンプトを起こさず直接実装。軸マッピング設定UI・複数bridge同時接続） | 実装済み |
| 3 | （同上。bridge保守コマンドGUI化） | 実装済み |
| 4 | [CODEX_PROMPT_PHASE4.md](CODEX_PROMPT_PHASE4.md) | 未着手（着手可） |
| 5 | [CODEX_PROMPT_PHASE5.md](CODEX_PROMPT_PHASE5.md) | 未着手（Phase 4完了後に着手可） |
| 6 | [CODEX_PROMPT_PHASE6.md](CODEX_PROMPT_PHASE6.md)（SteppingMotorDriver BLEアダプタ） | 未着手。要求仕様は解消済み（[BLE_WIFI_REQUIREMENTS.md](../SteppingMotorDriver/firmware/BLE_WIFI_REQUIREMENTS.md)）だが、実機結合確認にはファームウェア側BLE実装（[firmware/CODEX_PROMPT_BLE_PHASE1〜2.md](../SteppingMotorDriver/firmware/CODEX_PROMPT_BLE_PHASE1.md)）が必要 |
| 7 | [CODEX_PROMPT_PHASE7.md](CODEX_PROMPT_PHASE7.md)（制御アプリIPC中継クライアント） | 未着手。要求仕様は解消済み（[design/CONTROL_APP_REQUIREMENTS.md](../design/CONTROL_APP_REQUIREMENTS.md)）だが、制御アプリ本体が未実装のためモックサーバでの疎通確認までが範囲 |
| 8〜10 | [CODEX_PROMPT_PHASE8-10.md](CODEX_PROMPT_PHASE8-10.md) | ブロック中（Phase 6・7の完了待ち、詳細プロンプト未作成） |
| 11 | [CODEX_PROMPT_VERIFY_PANEL.md](CODEX_PROMPT_VERIFY_PANEL.md)（関節検証パネル、F-RAM-VERIFY） | ブロック中。ファームウェア側F-MOT-12（[firmware/CODEX_PROMPT_JOINT_ANGLE_PHASE1.md](../SteppingMotorDriver/firmware/CODEX_PROMPT_JOINT_ANGLE_PHASE1.md)）・BLE Joint Angleキャラクタリスティック・制御アプリの`MOVE_DEG`等中継実装待ち |

## 関連：SteppingMotorDriver ファームウェア側プロンプト

robot_arm_monitor Phase 6が依存するBLEテレメトリ機能は、ファームウェア側の別ロードマップ
（[BLE_WIFI_REQUIREMENTS.md](../SteppingMotorDriver/firmware/BLE_WIFI_REQUIREMENTS.md) §10）として実装する。

| Phase | プロンプト | 内容 |
|-------|-----------|------|
| 1 | [firmware/CODEX_PROMPT_BLE_PHASE1.md](../SteppingMotorDriver/firmware/CODEX_PROMPT_BLE_PHASE1.md) | NimBLE導入・GATTサービス実装 |
| 2 | [firmware/CODEX_PROMPT_BLE_PHASE2.md](../SteppingMotorDriver/firmware/CODEX_PROMPT_BLE_PHASE2.md) | ペアリング・ボンディング、`GET/SET BLE_ENABLE` |
| 3 | [firmware/CODEX_PROMPT_BLE_PHASE3.md](../SteppingMotorDriver/firmware/CODEX_PROMPT_BLE_PHASE3.md) | WiFi Station接続・USB-CDC経由プロビジョニング |
| 4 | [firmware/CODEX_PROMPT_BLE_PHASE4.md](../SteppingMotorDriver/firmware/CODEX_PROMPT_BLE_PHASE4.md) | WiFi TCPテレメトリサーバ・mDNS |
| 5 | [firmware/CODEX_PROMPT_BLE_PHASE5.md](../SteppingMotorDriver/firmware/CODEX_PROMPT_BLE_PHASE5.md) | 統合テスト（coexistence・アンテナ評価） |
| — | [firmware/CODEX_PROMPT_JOINT_ANGLE_PHASE1.md](../SteppingMotorDriver/firmware/CODEX_PROMPT_JOINT_ANGLE_PHASE1.md) | 関節角度出力・POTゼロ位置補正（F-MOT-12）。robot_arm_monitor Phase 11（関節検証パネル）が依存 |

robot_arm_monitor Phase 6の実機接続確認には、少なくともファームウェアPhase 1〜2の完了が必要。
