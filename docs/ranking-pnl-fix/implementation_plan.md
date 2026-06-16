# ランキング PnL 修正 実装計画

## 0. 背景と目的

**問題**：ランキングの SCORE（PnL）は `max(0, cumulative_payout − cumulative_cost − cumulative_fee_paid)` で計算される。しかし `cumulative_payout` は CLAIM（回収）TX 実行時のみ加算される（`bet.move` L109・L248・L282）。勝っても回収しないとスコアに反映されず、ランキングが不正確。

**目的**：ユーザーの回収操作に依存せず、決済確定済みの勝ちポジションがスコアに反映されるようにする。

**非目標**：スコア計算式そのものの変更。`PlayerStats` / `Arena` 構造体の変更。

---

## 1. 採用アプローチ

`claim_binary` / `claim_range` / `claim_break` を、**「呼び出し者（sender）」ではなく「マネージャーの登録所有者」をプレイヤーとして解決する permissionless 関数に変更する。**

これにより運営/bot が全プレイヤー分の決済済みポジションを代行回収でき、payout は各所有者の manager 残高へ入り、スコアが正しく更新される。

### なぜ二重計上が起きないか

`redeem_*` は predict 層でトークンを焼く。保有量を超える redeem は predict 層で弾かれ、redeem 済みトークンは存在しないため再 redeem しても payout=0。手動 CLAIM と代行 CLAIM が混在しても二重計上は起きない。

---

## 2. 契約変更

### 2-1. `contract/sources/arena.move`：所有者解決ヘルパーを追加

既存の `manager_to_player` テーブルを使い、manager_id から登録プレイヤーアドレスを逆引きするヘルパーを追加する。

追加箇所：`assert_player` の直後（L160 付近）

```move
/// manager_id からそのマネージャーを登録したプレイヤーのアドレスを解決する。
/// 未登録の manager_id の場合は ENotPlayer で abort する。
public(package) fun player_of_manager<Quote>(
    arena: &Arena<Quote>,
    manager_id: ID,
): address {
    assert!(arena.manager_to_player.contains(manager_id), ENotPlayer);
    arena.manager_to_player[manager_id]
}
```

`update_score` / `PlayerStats` / `Arena` 構造体は**変更しない**。

### 2-2. `contract/sources/bet.move`：claim 系 3 関数を所有者解決に変更

各 `claim_*` の冒頭3行を変更する。

**変更前（claim_binary L98-100、claim_break L232-234、claim_range L272-274）：**
```move
let player = ctx.sender();
let manager_id = object::id(manager);
arena::assert_player(arena, player, manager_id);
```

**変更後（3 関数すべて）：**
```move
let manager_id = object::id(manager);
let player = arena::player_of_manager(arena, manager_id);
// player は manager の登録所有者。sender が誰でもよい（permissionless）。
```

> **重要**：`open_binary` / `open_range` / `open_break`（BET 側）は**変更しない**。BET は資金を出す本人＝所有者であるべきで、`ctx.sender()` + `assert_player` + `manager.withdraw`（手数料徴収）が妥当。代行を許すのは CLAIM のみ。

---

## 3. オフチェーン精算 sweeper

決済済み・未回収ポジションを検出し `claim_*` をPTBで一括代行するワーカー。

### 3-1. 責務

1. arena の `players` テーブルから全プレイヤーと各 `manager_id` を取得（`contract-client.ts` の `listPlayers` を再利用可能）。
2. 各プレイヤーの建玉を `BinaryOpened` / `RangeOpened` / `BreakOpened` イベントから集計（portfolio API のスキャンロジックを流用）。
3. 各ポジションの oracle が **settled** か判定。settled かつ **未 redeem**（manager がまだ対象トークンを保有）のものを抽出。
4. 抽出分について `claim_binary` / `claim_range` / `claim_break` をPTBにまとめて署名・実行。

### 3-2. 実行モデル

- cron/bot で定期実行（各ラウンド決済の数分後）。
- ガス（SUI）は **sweeper 運用者（運営）負担**。PTBで複数ポジションをまとめてガス効率化。
- 冪等性：再実行しても焼くトークンが無ければ実質 no-op。
- 配置：`contract/scripts/` 以下（秘密鍵は環境変数/プラットフォームシークレット。`.env` はコミット禁止）。

---

## 4. テスト計画（`contract/tests/bet_tests.move` 拡張）

注：`Predict` / `PredictManager` / `OracleSVI` は public(package) コンストラクタのため deep_arena テストから構築不可。`claim_*` 本体のフロー検証はテストネット PTB で行う（既存方針を継続）。追加するのは `player_of_manager` のユニットテスト。

1. **正常取得**：arena に player+manager_id を登録 → `player_of_manager` が正しいアドレスを返す。
2. **未登録 abort**：未登録 manager_id → `ENotPlayer`（abort_code=1）で abort する。

---

## 5. デプロイ計画

- **Sui パッケージ upgrade を使用**（新規デプロイではなく）。`UpgradeCap` が必要。
- 本設計は struct を変えず関数の追加・本体変更のみ → **upgrade 互換**。既存 arena オブジェクトとプレイヤーデータは保持される。
- upgrade 後、フロントの `deepArenaPackageId`（`dapp/src/lib/deep-arena/config.ts`）を新パッケージ ID に更新。
- **本番デプロイは必ずユーザーの明示承認後**。

---

## 6. リスク・留意点

| 項目 | 内容 | 対策 |
|---|---|---|
| upgrade 互換 | struct 変更不可。今回は関数のみなので安全だが要検証 | `sui move build` + テストネットで upgrade リハーサル |
| sweeper ガス | プレイヤー×ポジション数に比例 | PTB バッチ＋残高確認で未 redeem のみ対象 |
| 検出漏れ | イベントページング上限 | portfolio API と同じページング上限ロジックを踏襲 |
| スコア反映遅延 | sweeper 実行間隔分だけスコア反映が遅れる | 間隔を決済後数分に設定 |
| 秘密鍵管理 | sweeper 署名鍵の漏洩リスク | 専用低権限鍵、シークレット管理、ガス上限 |

---

## 7. 成果物チェックリスト

- [x] `arena.move`：`player_of_manager` 追加
- [x] `bet.move`：`claim_binary` / `claim_range` / `claim_break` を所有者解決に変更（open 系は不変）
- [x] `bet_tests.move`：`player_of_manager` ユニットテスト 2 件追加、`sui move test` green
- [x] ~~sweeper スクリプト：`dapp/scripts/sweeper.mts`~~ → **廃止（方針A採用）**
  - 当初は「オンチェーン `score` を代行 CLAIM で正す」方針だったが、(1) 直接 redeem 済み分は回収不能、(2) range は `predict::redeem_range` の owner チェックで代行不可、(3) oracle 決済待ち、の制約で根本解決にならず。
  - 表示を方針A（イベントから PnL 再構築）に切り替えたため不要となり、`dapp/scripts/sweeper.mts` と `package.json` の `sweep`/`sweep:execute` を削除。
  - デプロイ済みコントラクト（permissionless `claim_*`・`player_of_manager`）は無害のため温存。
- 詳細設計は [approach-a-design.md](./approach-a-design.md) を参照。
- [x] testnet upgrade 完了
  - 旧パッケージ: `0xb3b546...019a22aa`、新パッケージ: `0xfb6c60...d7cc76`
  - TX digest: `8t15LqnhBjtU6gM4cpZvbk3PeRkMqsbvjDeuBdysALgn`
  - `join_arena` の `ctx: &mut TxContext` → `ctx: &TxContext` に修正（upgrade 互換）
- [x] フロント `deepArenaPackageId` 更新（`config.ts`・`sweeper.mts`・`Move.toml`）
- [x] 本番 upgrade 完了（testnet が本番環境）
