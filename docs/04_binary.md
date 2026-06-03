# 04_binary（Binaryマーケット取引）

## 1. 目的・役割

`deep_arena::binary` は、Arena 参加者が Binary（up/down）予測建玉を売買するためのユーザー向けエントリーです。

## 2. 設計方針

- **鍵の整合性**: `arena.predict_id() == object::id(predict)` と `arena.manager_id(player) == object::id(manager)` を必ず検証。
- **開始は Active 限定 / 決済は期限後も可**: 新規建玉（open）は開催期間中のみ。決済（close）は期限後も可能。
- **スコア定義（MVP）**: 取引直後の `manager.balance<Quote>()` をスコアとして上書き。

## 3. 処理フロー（open_binary）

```
Player → binary::open_binary(arena, predict, manager, oracle, ...)
  ↓
arena: is_active / is_player / predict_id / manager_id 検証
  ↓
predict_adapter: preview_binary(...) で cost 取得
  ↓
predict_adapter: mint_binary(...)
  ↓
DeepBook Predict: predict::mint(...)
  ↓
arena: set_score(player, manager.balance)
  ↓
events: binary_opened 発火
```

## 4. 他モジュールとの連携

- **predict_adapter**: `preview_binary` / `mint_binary` / `redeem_binary` を利用。
- **arena**: 検証し、`set_score` でスコア更新。
- **events**: `binary_opened` / `binary_closed` を発火。

---

*Issue #10 参照: Deep Arena 開発計画・ロードマップ*
