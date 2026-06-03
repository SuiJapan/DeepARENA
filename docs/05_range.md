# 05_range（Vertical Rangeマーケット取引）

## 1. 目的・役割

`deep_arena::range` は、Arena 参加者が Vertical Range（下限・上限ストライクの区間）予測建玉を売買するユーザー向けエントリーです。

## 2. 設計方針

- **binary と同一パターン**: 検証・スコア更新・イベント発火の流れは binary と揃え、保守性を高める。
- **キーの制約**: `lower_strike < higher_strike` が必須。
- **開始は Active 限定 / 決済は期限後も可**: binary と同じ。
- **スコア定義（MVP）**: 取引直後の `manager.balance<Quote>()` をスコアとして上書き。

## 3. binary との差分

| 項目 | binary | range |
|------|--------|-------|
| キー | MarketKey (strike, is_up) | RangeKey (lower_strike, higher_strike) |
| adapter 関数 | mint_binary / redeem_binary | mint_range / redeem_range |
| イベント | BinaryOpened / BinaryClosed | RangeOpened / RangeClosed |
| 勝敗条件 | 満期価格が strike より up/down か | 満期価格が [lower, higher] 区間内か |

## 4. 他モジュールとの連携

- **predict_adapter**: `preview_range` / `mint_range` / `redeem_range` を利用。
- **arena**: 検証し、`set_score` でスコア更新。
- **events**: `range_opened` / `range_closed` を発火。

---

*Issue #11 参照: Deep Arena 開発計画・ロードマップ*
