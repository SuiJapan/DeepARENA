# 02_events（イベント定義）

## 1. 目的

`deep_arena::events` は、Arena のライフサイクル・取引・流動性・スコアの各アクションをオンチェーンイベントとして発火する一元モジュールです。

## 2. 設計方針

- すべてのイベント構造体は `has copy, drop`（保存せず、その場で破棄される）。
- 発火関数は `public(package)`：同一パッケージ内モジュールからのみ呼ばれる。
- 金額は `u64`（DUSDC = 6桁）。オブジェクト識別子は `ID`、ユーザは `address`。

## 3. イベント一覧

| イベント | 発火タイミング |
|---------|----------------|
| ArenaCreated | 新しい Arena が作成されたとき |
| ArenaSettled | Arena が清算・終了したとき |
| PlayerJoined | プレイヤーが参加・入金したとき |
| BinaryOpened | Binary 建玉を mint したとき |
| BinaryClosed | Binary 建玉を redeem したとき |
| RangeOpened | Range 建玉を mint したとき |
| RangeClosed | Range 建玉を redeem したとき |
| LiquidityProvided | LP が quote を供給し PLP を受領したとき |
| LiquidityWithdrawn | LP が PLP を burn し quote を引き出したとき |
| ScoreUpdated | スコア／順位が更新されたとき |

---

*Issue #8 参照: Deep Arena 開発計画・ロードマップ*
