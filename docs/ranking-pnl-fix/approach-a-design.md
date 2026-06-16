# ランキング PnL 修正 — 方針A（オフチェーン算出）精密設計書

> 実装担当モデル向け。コード片はすべて「仕様」であり、最終実装はリポジトリの既存スタイルに合わせること。

## 0. ゴールと不変条件

- **ゴール**: ランキングページの "Score (PnL)" を、ユーザーが CLAIM したか・どの経路で redeem したかに依存せず正しく表示する。
- **根本原因（確定済み）**: オンチェーン `PlayerStats.score` は `cumulative_payout` に依存するが、これは DeepARENA の `claim_*` を通った払戻しか加算されない。ユーザーが DeepBook Predict から直接 redeem すると payout が捕捉されず、score が 0 のまま固定される。
- **方針A の核心**: PnL を**オンチェーンの確定イベントからオフチェーンで再構築**し、ランキングはオンチェーン `score` ではなくこの算出値を表示する。
  - **コスト＋手数料** = DeepARENA 自身の `*Opened` イベント（BET は必ず DeepARENA 経由なので完全）
  - **払戻** = DeepBook Predict 層の `PositionRedeemed` / `RangeRedeemed` イベント（redeem 経路に依存せず全件捕捉）
- **確定した意味論（§6）**:
  - PnL = `attributedPayout − cost − fee`、**0 床を取らず負値も表示**（§6-1）。
  - **実現損益のみ**（redeem 済みの払戻だけ計上。保有中ポジションの時価評価は含めない）（§6-2）。
  - 方針A 採用に伴い**スイーパーは廃止**（§6-4）。
- **不変条件**:
  - 契約（Move）の変更は**不要**。
  - `PlayerSummary` 型・`/api/arena/leaderboard` のレスポンス形・`ranking-section.tsx` は**変更不要**（`PlayerSummary` を生成する `listPlayers()` の中身だけを差し替える）。
  - 過去スコアもイベントが永久に残るため**自動的に正しく復元される**（あきらめ不要）。

---

## 1. 確定した事実（オンチェーン定義）

### 1-1. コスト/手数料の出所：DeepARENA イベント

パッケージ: **旧 `0xb3b546a75389e222acd043d4ce5a4d85b9a616ec55f98ede5e50d89b019a22aa`** と **新 `0xfb6c60a5447e2ca878d89f989ca3395b784bc605a5eb82962526396a2bd7cc76`** の**両方**を必ず照会する（upgrade 前の BET は旧パッケージ ID でイベント発火している）。

`{pkg}::events::BinaryOpened`（[events.move:27](../../contract/sources/events.move)）:
| フィールド | 型 | 用途 |
|---|---|---|
| `arena_id` | ID | この arena (`config.arenaObjectId`) でフィルタ |
| `player` | address | プレイヤー |
| `manager_id` | ID | マネージャー |
| `oracle_id` | ID | ポジションキー |
| `expiry` | u64 | ポジションキー |
| `strike` | u64 | ポジションキー |
| `is_up` | bool | ポジションキー（direction） |
| `quantity` | u64 | arena 保有数量 |
| `cost` | u64 | **コスト（quote atomic）** |
| `fee` | u64 | **手数料（quote atomic）** |

`{pkg}::events::RangeOpened`: 上記の `strike/is_up` の代わりに `lower_strike: u64`, `higher_strike: u64`。`cost`/`fee`/`quantity` 同様。

`{pkg}::events::BreakOpened`: `lower_strike: u64`, `upper_strike: u64`。`cost` は**2レッグ合計**。**重要**: Break は内部的に「(oracle, expiry, lower_strike, DOWN)」と「(oracle, expiry, upper_strike, UP)」の 2 つの binary レッグを mint する。payout 照合時はこの 2 キーへ `quantity` を割り当てる（後述）。

### 1-2. 払戻の出所：Predict イベント

パッケージ: **`0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138`**（Predict は upgrade されておらず単一・安定。`PREDICT_BINARY_CONFIG.packageId` と同一）。

`{predictPkg}::predict::PositionRedeemed`（[predict.move:64](../../contract/vendor/deepbook_predict/sources/predict.move)）:
| フィールド | 型 | 用途 |
|---|---|---|
| `manager_id` | ID | arena マネージャーへの帰属 |
| `oracle_id`, `expiry`, `strike`, `is_up` | | ポジションキー |
| `quantity` | u64 | この redeem の数量 |
| `payout` | u64 | **払戻（quote atomic）** |
| `is_settled` | bool | 参考（live 売り/決済 redeem 両方 payout 有。両方カウント） |

`{predictPkg}::predict::RangeRedeemed`（[predict.move:94](../../contract/vendor/deepbook_predict/sources/predict.move)）:
- `manager_id`, `oracle_id`, `expiry`, `lower_strike`, `higher_strike`, `quantity`, `payout`, `is_settled`。
- **注意**: dapp 既存ヘルパーには `PositionRedeemed` 用しか無く、**`RangeRedeemed` 用は未実装**。新規に追加が必要。

### 1-3. 単位

`cost` / `fee` / `payout` はすべて **quote（DUSDC, 6 decimals）の atomic 値**で同一単位。スケール変換不要。`strike`/価格系は float-scaling だが PnL 計算には使わない。

### 1-4. プレイヤー↔マネージャーの対応

`arena.move` の `join_arena` は「1 プレイヤー = 1 マネージャー」「1 マネージャー = 1 プレイヤー」を両テーブルで強制（[arena.move:125-126](../../contract/sources/arena.move)）。よって arena 内で **manager_id ↔ player は 1:1**。プレイヤー一覧と対応は既存の `listPlayers()` の players テーブル走査をそのまま使う。

---

## 2. PnL 算出アルゴリズム（精密仕様）

### 2-1. 全体式

```
playerPnL = attributedPayout − totalCost − totalFee     // 0 床を取らない。負値もそのまま表示する
```

- **決定（§6-1）**: 負の PnL も表示する。0 床（`max(0,…)`）は取らない。
- **型・表示・ソートの拡張が必要**（負値非対応の現行から変更）:
  - 現行 `TokenAmount.atomic` は `/^\d+$/`（非負整数文字列のみ）で、`ranking-section.tsx` の `readTokenAmount` も同正規表現で弾く（[ranking-section.tsx:25](../../dapp/src/features/deep-arena/ranking-section.tsx)）。負値を通すには `score` を符号付きで表現できる形へ変える。
  - **推奨方式**: `PlayerSummary` に符号付き PnL 専用フィールドを追加する（`deposited` 等の他の `TokenAmount` は非負のままにできるため、`TokenAmount` 全体の意味を壊さない）。例:
    - `types.ts`: `score` の atomic を符号付き許容にするのではなく、`pnlAtomic: string`（`/^-?\d+$/`）を新設 or `score.atomic` の検証を `/^-?\d+$/` に緩和。**どちらにするかは実装時にリポジトリ整合で判断**。本設計では「`score` を符号付き（`/^-?\d+$/`）に拡張」を基本線とする。
  - `ranking-section.tsx`:
    - `readTokenAmount` の `atomic` 検証を `/^-?\d+$/` に緩和。
    - `formatAmount` は `Number(atomic)/10**decimals` で負値も正しく整形されるが、マイナス記号の体裁（例 `-12.34 DUSDC`、色分け等）は表示要件に合わせる。
  - **ソート**: `BigInt(b.score.atomic) - BigInt(a.score.atomic)` は `BigInt` が負値を扱えるため**ロジック変更不要**。降順で負値が下位に並ぶ。

### 2-2. なぜ payout は「単純合算」ではなく「キー照合上限」なのか

`PositionRedeemed`/`RangeRedeemed` は **manager_id でしか紐づかない**。同一マネージャーが arena 外（参加前・別 arena・純 Predict 取引）で建てたポジションの redeem も混ざる。単純合算すると**arena 外の払戻を誤って加点**する。

→ **arena が「所有」する数量分だけを payout として帰属させる**。所有数量は DeepARENA の `*Opened` イベントが正確に教える。

### 2-3. データ構造

ポジションキーの正規化文字列:
- binary: `K = `${managerId}|${oracleId}|${expiry}|${strike}|${isUp?1:0}``
- range: `RK = `${managerId}|${oracleId}|${expiry}|${lowerStrike}|${higherStrike}``

マネージャー単位の集計:
```ts
interface ManagerAccumulator {
    totalCost: bigint;   // Σ Opened.cost
    totalFee: bigint;    // Σ Opened.fee
    openedQtyByKey: Map<string, bigint>;   // binary キー → arena 建玉数量累計
    openedQtyByRangeKey: Map<string, bigint>;
    attributedPayout: bigint;  // 帰属payout（後段で算出）
}
```

### 2-4. ステップ

**Step 1 — プレイヤー集合とマネージャー対応**
既存 `listPlayers()` の前半（arena players テーブル走査）を流用し、`player`・`manager_id`・`cumulative_cost`（フォールバック表示用）を取得。`managerId → player` の Map と、arena 参加マネージャー集合 `arenaManagerIds: Set<string>` を作る。

**Step 2 — Opened イベントでコスト・手数料・建玉数量を集計**
旧+新パッケージ × {BinaryOpened, RangeOpened, BreakOpened} を `suix_queryEvents`（`MoveEventType`）でページング取得。各イベントについて:
- `arena_id !== config.arenaObjectId` ならスキップ。
- `manager_id` の `ManagerAccumulator` に対し:
  - `totalCost += cost`, `totalFee += fee`
  - Binary: `openedQtyByKey[K] += quantity`
  - Range: `openedQtyByRangeKey[RK] += quantity`
  - **Break**: `openedQtyByKey[(oracle,expiry,lower_strike,DOWN=isUp:false)] += quantity` **かつ** `openedQtyByKey[(oracle,expiry,upper_strike,UP=isUp:true)] += quantity`。`totalCost += cost`（2レッグ合計、1回のみ）, `totalFee += fee`。

**Step 3 — Redeem イベントで payout を「キー照合・上限付き」で帰属**
Predict パッケージ × {PositionRedeemed, RangeRedeemed} を取得。`manager_id ∈ arenaManagerIds` のみ対象。

帰属は**キー単位の累積上限**で行う（部分 redeem・再建玉・過剰 redeem を正しく扱う）:
```
// キー K ごとに「まだ arena 所有として帰属できる残数量」を管理
remainingByKey[K] = openedQtyByKey[K]   // 初期値（Step2の累計）

// redeem イベントを時刻昇順（timestampMs, 同値なら digest）でソートして処理
for each redeem (binary) sorted by time:
    rem = remainingByKey[K] ?? 0
    if rem <= 0: continue
    attributableQty = min(redeem.quantity, rem)
    // payout を数量比で按分（redeem ごとに価格が違うため）
    attributedPayout(manager) += redeem.payout * attributableQty / redeem.quantity   // bigint 除算は下記注意
    remainingByKey[K] = rem − attributableQty
```
- **bigint 按分**: `redeem.payout * attributableQty / redeem.quantity` を `(payout * attributableQty) / quantity`（乗算先行→整数除算）で計算。`attributableQty === quantity` のときは `payout` そのまま（最頻ケース。丸め誤差ゼロ）。
- range も `remainingByRangeKey` で同様。
- **`is_settled` に関わらず両方カウント**（早期 live 売りも正当な払戻）。

**Step 4 — PnL 確定と PlayerSummary 生成**
```
for each player:
    acc = accumulatorByManager[player.managerId]   // 無ければ全0
    pnl = acc.attributedPayout − acc.totalCost − acc.totalFee   // 0 床を取らない。負値可（bigint）
    score.atomic = pnl.toString()                  // 負値は "-12345" の形（符号付き）
    deposited.atomic = acc.totalCost.toString()    // "Total Bet" 列。現行の cumulative_cost と同義（非負）
```
ソート（score 降順）・rank 採番は既存ロジックを流用（`BigInt` は負値対応のため変更不要）。

---

## 3. 実装配置

| 対象 | 変更内容 |
|---|---|
| `dapp/src/lib/deep-arena/pnl-calculator.ts`（新規） | §2 のアルゴリズムを純関数群で実装。テスト可能に分離。`computeLeaderboardPnl(input): Map<managerId, {pnl, cost, fee}>` のような I/F。 |
| `dapp/src/lib/deep-arena/contract-client.ts` | `listPlayers()` を改修。Step1（players テーブル）はそのまま、Step2-4 を追加。`score` を on-chain `stats.score` から算出 PnL に差し替え。Opened/Redeem イベント取得ヘルパーを内部に追加（既存 `queryMoveEvents` パターンを移植 or import）。 |
| `dapp/src/lib/deep-arena/config.ts` | 旧パッケージ ID 定数を追加（`deepArenaPreviousPackageIds: string[]`）。現状 sweeper にハードコードされている `0xb3b546…` をここへ。Predict パッケージ ID は既存 `predictPackageId` を使用。 |
| `dapp/src/lib/predict-binary/client.ts` | `RANGE_REDEEMED_EVENT_TYPE` 定数・`readRangeRedeemedEvent()`・`queryRangeRedeemedEvents()` を追加（既存 `PositionRedeemed` 系のミラー）。または pnl-calculator 側に内包。 |
| `/api/arena/leaderboard/route.ts` | **変更不要**（`listPlayers()` の戻り型が同じ）。ただし event 全件走査で実行時間が伸びるため `revalidate`（現 30 秒）と関数タイムアウトの再検討のみ。 |
| `ranking-section.tsx` / `types.ts` | **変更不要**。注記文言「Score is net PnL recorded onchain…」は実態に合わせ「reconstructed from onchain events」等へ更新を検討（任意）。 |

**イベント取得の共通化**: 既存の堅牢な実装（リトライ・ページング）が [client.ts:1899-1958](../../dapp/src/lib/predict-binary/client.ts) にある。これを `pnl-calculator` から再利用するのが望ましい（重複実装を避ける）。`queryMoveEvents` は `MoveEventType` 単一指定なので、DeepARENA 旧/新 × 3 種、Predict × 2 種をそれぞれ呼ぶ。

---

## 4. エッジケースと正しい挙動（テスト必須項目）

| ケース | 期待挙動 |
|---|---|
| 直接 Predict UI で redeem 済み（qty=0） | Redeem イベントは残る → payout 帰属される。**これが本修正の主目的**。 |
| 未 CLAIM の勝ちポジション保有中 | Redeem イベント無し → payout 未計上（実現損益のみ。oracle 未決済でも同じ）。§6 で時価評価は別途検討。 |
| arena 外で使ったマネージャーの払戻 | `openedQtyByKey` が 0 → 帰属 0。誤加点しない。 |
| 部分 redeem（複数イベントに分割） | 残数量上限で按分加算。 |
| 同一キーを redeem 後に再建玉（open→redeem→open） | `openedQty` は累計、`remaining` も累計消化。累積 redeem ≤ 累積 arena 建玉 の範囲で全帰属。超過分（arena 外）は除外。 |
| Break の 2 レッグ | 2 つの binary キーに数量割当 → 各レッグの PositionRedeemed が別々に帰属。 |
| 旧パッケージ時代の BET | 旧 pkg の Opened イベントも取得しているので cost/qty 計上される。 |
| payout < cost（負 PnL） | **負値のまま表示**（§6-1 決定。0 床にしない）。 |
| イベントページング上限到達 | `reachedLimit` を検知してログ/警告。取りこぼし防止のため上限値を十分大きく（§5）。 |

---

## 5. スケール・性能の注意

- `PositionRedeemed`/`RangeRedeemed` は **Predict 全ユーザー横断**で発火するため、arena 利用者だけでなく母数が大きい。`MoveEventType` 単一フィルタしかできず、サーバー側 manager フィルタは不可 → 全件ページングしてクライアント側で `arenaManagerIds` フィルタ。
- testnet 規模では許容。**本番/将来はインデクサ（カスタム or Sui のイベント DB）に切り替える前提**を残す。
- `maxPages`/`pageSize` は取りこぼさない値に設定し、`reachedLimit===true` のときはレスポンスに警告メタを載せる（任意）。
- `route.ts` の `revalidate=30` で 30 秒キャッシュ。全件走査が重い場合は段階的にキャッシュ時間延長 or バックグラウンド更新。

---

## 6. プロダクト判断ポイント（決定済み）

1. **負の PnL を表示するか** → **表示する（決定）**。0 床は取らない。型・表示・ソートの対応は §2-1 に詳述。
2. **実現損益のみ vs 時価込み** → **実現損益のみ（決定）**。redeem 済み（`PositionRedeemed`/`RangeRedeemed`）の払戻だけを計上する。保有中・未 redeem ポジションの時価評価は**含めない**。
3. **手数料を PnL に含めるか** → `cost + fee` を差し引く（オンチェーン式と一致。据え置き）。
4. **スイーパーの位置づけ** → **廃止（決定）**。方針A 採用後はランキング表示にオンチェーン `score` を使わないため、`score` を埋めるためのスイーパー（`dapp/scripts/sweeper.mts`）は不要。
   - 実装フェーズで併せて整理する対象:
     - `dapp/scripts/sweeper.mts` の削除
     - `dapp/package.json` の `sweep` / `sweep:execute` スクリプト削除
     - `docs/ranking-pnl-fix/implementation_plan.md`（旧スイーパー方針の記録）の扱い（残すなら「廃止」と追記）
   - 契約側（`bet.move` の permissionless `claim_*`・`arena.move` の `player_of_manager`）は既にデプロイ済みで害は無いため、**コントラクトの巻き戻しは行わない**（そのまま温存）。

---

## 7. 検証計画

1. **ユニットテスト**（`pnl-calculator.ts`）: §4 の各ケースを合成イベント列で検証。特に「直接 redeem」「部分 redeem 按分」「arena 外マネージャー除外」「Break 2 レッグ」。
2. **実データ照合**: 既知のマネージャー（例 `0xa58791acf1…`）について、手計算した payout−cost−fee と API 出力が一致するか。
3. **回帰**: ランキング API レスポンス形が変わっていないこと（`PlayerSummary[]`）。
4. **性能**: leaderboard API のレスポンス時間と `reachedLimit` を計測。

---

## 8. 既知の参照ファイル（実装時の起点）

- コスト/手数料イベント定義: [contract/sources/events.move](../../contract/sources/events.move)
- 払戻イベント定義: [contract/vendor/deepbook_predict/sources/predict.move:50-107](../../contract/vendor/deepbook_predict/sources/predict.move)
- 現行ランキング取得: [dapp/src/lib/deep-arena/contract-client.ts:185-250](../../dapp/src/lib/deep-arena/contract-client.ts)
- 既存イベントクエリ基盤（再利用）: [dapp/src/lib/predict-binary/client.ts:1899-2135](../../dapp/src/lib/predict-binary/client.ts)
- API ルート: [dapp/app/api/arena/leaderboard/route.ts](../../dapp/app/api/arena/leaderboard/route.ts)
- 表示コンポーネント: [dapp/src/features/deep-arena/ranking-section.tsx](../../dapp/src/features/deep-arena/ranking-section.tsx)
- パッケージ ID: 新 `0xfb6c60a5447e2ca878d89f989ca3395b784bc605a5eb82962526396a2bd7cc76` / 旧 `0xb3b546a75389e222acd043d4ce5a4d85b9a616ec55f98ede5e50d89b019a22aa` / Predict `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138`
