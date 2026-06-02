# DeepARENA MVP 設計書

## 1. 概要

**DeepARENA** は、DeepBook Predict だけを使ったストラテジープラットフォームです。

ユーザーは、価格の上昇・下落・レンジ滞在を予想し、標準化された Predict ポジションを戦略カードとして作成します。DEEP ARENA は、難しいオプション理論や証拠金管理を前面に出さず、満期時の payoff、リスク倍率、スコア、ランキングとして見せます。

MVPでは、以下は扱いません。

* DeepBook Spot 取引
* DeepBook Margin の実ポジション
* コピートレード
* DEEP ARENA 独自の預け入れ型 Strategy Vault
* ストラテジストが他人の資金を運用する仕組み

DeepBook Predict プロトコル自体には liquidity vault / PLP がありますが、DEEP ARENA MVPではそれを「ユーザー資金を預かるVault機能」として拡張しません。アプリは、ユーザー自身の `PredictManager` と Predict ポジションをわかりやすく操作・可視化することに集中します。

---

## 2. コンセプト

> **Predictだけで、相場観・リスクの取り方・満期結果を競う戦略アリーナ**

DeepARENA の中心は、取引量や自由なレバレッジではなく、以下の3つです。

1. どの予測を選んだか
2. どのリスク倍率で参加したか
3. 満期時にどの payoff になったか

---

## 3. 目的

DeepBook Predict は binary position と vertical range を扱えます。これをそのまま見せると、ユーザーには strike、expiry、oracle、mint cost、redeem payout、range key などの概念が難しく見えます。

DeepARENA は、それらを次のような戦略カードに変換します。

* Directional Duel: 上か下かを当てる
* Range Master: 指定レンジに収まるかを当てる
* Hedge Master: メイン予測と保険予測を組み合わせる

ユーザーは「オプションを組む」のではなく、「戦略カードを選ぶ」体験にします。

---

## 4. 断定する方針

## 4.1 Marginの自由入力はしない

DEEP ARENAで、ユーザーに以下を自由入力させません。

* 1.7x、4.3x のような任意倍率
* 担保率
* 清算価格
* 借入利息
* 証拠金維持率
* MarginManager 経由の自由な借入・返済

短期MVPでは、UIも計算も破綻しやすいためです。

## 4.2 Marginは実取引ではなくリスク倍率にする

MVPの `1x / 2x / 3x` は、DeepBook Margin の実ポジションではありません。

これは Predict 戦略カードに付与する **固定リスク倍率** です。

| 倍率 | 内部名 | UI表示 | 意味 |
| ---: | --- | --- | --- |
| 1x | Normal | Normal | 通常リスク。スコア倍率なし |
| 2x | Aggressive | Aggressive | 攻め。投入額またはスコアを2倍扱い |
| 3x | High Risk | High Risk | 高リスク。投入額またはスコアを3倍扱い |

画面上では、より直感的に次の表示でもよいです。

| 選択 | 表示名 | 意味 |
| ---: | --- | --- |
| 1x | Safe | 自分の資金だけで通常サイズ |
| 2x | Attack | 2倍サイズ相当で勝負 |
| 3x | All-in Style | 3倍サイズ相当で勝負。スコア倍率あり |

注意:

* 清算価格は表示しません。
* 借入利息は表示しません。
* MVPでは「固定レバレッジ選択」ではなく「固定リスク倍率」と説明します。
* 将来拡張でも、DeepBook Margin の自由入力機能にはしません。

## 4.3 Payoffは標準形を表示する

オプションの損益計算をゼロから発明しません。

必要なのは、DeepBook Predict の見積もり結果と満期結果を、DEEP ARENA向けにわかりやすく表示することです。

表示するもの:

* Entry cost: 購入に必要な quote asset
* Max loss: 最大損失
* Max payout: 満期時に得られる最大受取
* Break-even view: 損益分岐の簡易説明
* Expiry payoff: 満期時の勝ち負け
* Score impact: Arenaスコアへの影響

---

## 5. DeepBook Predict連携方針

DEEP ARENA は、DeepBook Predict の既存コントラクトを実行基盤として使います。

## 5.1 Predict

`Predict` shared object は、アプリがユーザー操作を通すメインの入口です。

MVPで使う可能性が高い操作:

* `create_manager()`: ユーザー用 `PredictManager` を作成
* `get_trade_amounts()`: binary position の mint cost / redeem payout をプレビュー
* `mint()`: binary position を購入
* `redeem()`: binary position を売却
* `redeem_permissionless()`: settled position を第三者でも償還
* `get_range_trade_amounts()`: vertical range の mint cost / redeem payout をプレビュー
* `mint_range()`: vertical range position を購入
* `redeem_range()`: vertical range position を売却

MVPでは、まず binary position を中心にします。vertical range は利用可能な market / oracle / deployment を確認したうえで有効化します。

## 5.2 PredictManager

`PredictManager` は、ユーザーごとの shared account object です。

役割:

* DeepBook `BalanceManager` をラップする
* quote asset 残高を持つ
* Predict positions を内部数量として記録する
* binary positions と vertical ranges を管理する

重要:

* binary position と vertical range は、ユーザーごとに独立した onchain object として増えるわけではありません。
* ユーザーは原則として1つの `PredictManager` を作成し、再利用します。
* DEEP ARENAの「参加中カード」は、onchain position数量とアプリ側の `ArenaPosition` 記録を対応させて表示します。

## 5.3 MarketKey / RangeKey

Predict position は key で識別します。

Binary:

* oracle ID
* expiry
* strike
* direction: UP / DOWN

Vertical range:

* oracle ID
* expiry
* lower strike
* higher strike

DEEP ARENAでは、これをユーザーに直接入力させず、戦略カードのフォームから生成します。

## 5.4 Oracle

`OracleSVI` は、特定の underlying asset と expiry の market state です。

利用する情報:

* underlying asset
* spot price
* forward price
* expiry
* status
* settlement price
* last update timestamp

MVPでは、ユーザーに oracle の技術詳細を見せず、以下に変換します。

* 対象: SUI / USD など
* 現在価格
* 満期までの残り時間
* 予測ライン
* settlement 後の結果

## 5.5 Registry

`Registry` は、Predict object ID と oracle ID を探すための共有 object です。

DEEP ARENA側で行うこと:

* active Predict object ID を読む
* 利用可能な oracle ID を読む
* 対応 market をアプリ設定として管理する

DEEP ARENA側でMVPでは行わないこと:

* oracle作成
* quote asset追加
* pricing config変更
* risk config変更
* withdrawal limiter変更

## 5.6 Predict protocol Vault

DeepBook Predict protocol の vault は、quote assets を保持し、すべての取引の反対側を取る liquidity vault です。

DEEP ARENA MVPでは、この vault に直接 LP 供給する機能は作りません。

将来的な拡張として、PLP供給画面や liquidity analytics を追加できます。ただし、これは「戦略Vault」ではなく「Predict protocol liquidity」機能として分けて扱います。

---

## 6. MVPで作るもの

1. Wallet接続
2. PredictManager 作成 / 検出
3. quote asset deposit / withdraw
4. 対応 market / oracle 一覧
5. 戦略カード一覧
6. 戦略カード作成フォーム
7. payoff preview
8. binary position mint
9. binary position redeem
10. vertical range preview / mint / redeem
11. ArenaPosition 記録
12. Arena score 計算
13. ランキング
14. ユーザーダッシュボード

---

## 7. MVPで作らないもの

* DeepBook Spot
* DeepBook Margin 実取引
* 任意レバレッジ
* 清算価格計算
* 借入利息計算
* copy follow
* Strategy Vault
* 他人の資金の運用
* performance fee
* high-water mark
* keeper / bot
* 独自 oracle 作成
* permissionless market 作成
* Predict protocol の admin操作

---

## 8. 戦略カード

MVPでは3枚に絞ります。

## 8.1 Directional Duel

方向勝負です。

例:

* 現在のSUI価格: 1.00 DUSDC
* お題: 30分後、SUIは1.02 DUSDCより上か
* ユーザーA: UPに100 DUSDC
* ユーザーB: DOWNに100 DUSDC

Predict上の対応:

* UP: binary UP position
* DOWN: binary DOWN position
* key: oracle ID + expiry + strike + direction

表示:

* 現在価格
* strike
* expiry
* UP価格 / DOWN価格
* Entry cost
* Max payout
* Max loss
* payoff preview
* risk multiplier

このカードをDEEP ARENAの中心にします。

## 8.2 Range Master

レンジ職人です。

例:

* 現在のSUI価格: 1.00 DUSDC
* お題: 1時間後、SUIは0.98から1.03 DUSDCの範囲内にいるか

Predict上の対応:

* vertical range position
* key: oracle ID + expiry + lower strike + higher strike

表示:

* lower strike
* upper strike
* expiry
* range price
* Entry cost
* Max payout
* Range payoff chart
* settlement price が範囲内か

実装注意:

* 公式仕様には `mint_range()` / `redeem_range()` / `get_range_trade_amounts()` がある。
* ただし、実際の deployment で対象 oracle / range が利用できるか確認する。
* 間に合わない場合、MVPでは UI と preview だけ用意し、実取引は Directional Duel に限定する。

## 8.3 Hedge Master

ヘッジ職人です。

SpotやMarginは使わず、Predictだけで「メイン予測」と「保険予測」を組み合わせます。

例:

* 現在のSUI価格: 1.00 DUSDC
* メイン: 30分後にSUIが1.02 DUSDCを上回る
* 保険: 30分後にSUIが0.98 DUSDCを下回る
* 配分: メイン80%、保険20%

Predict上の対応:

* Leg A: binary UP
* Leg B: binary DOWN
* 両方とも同じ oracle / expiry を使う
* strike は別でもよい

表示:

* Main thesis
* Protection leg
* Allocation
* Combined entry cost
* Worst case
* Best case
* payoff scenario table
* hedge score

Hedge Master は、単純な当たり外れではなく「損失をどう抑えたか」を評価します。

---

## 9. リスク倍率

ユーザーは、各戦略カードで次の3択だけを選びます。

| 倍率 | ラベル | 使い方 |
| ---: | --- | --- |
| 1x | Normal | 通常参加 |
| 2x | Aggressive | stake または score の2倍扱い |
| 3x | High Risk | stake または score の3倍扱い |

MVPでの実装方法は2案あります。

## 9.1 Quantity multiplier

ユーザーの入力 stake に倍率をかけて、Predict mint quantity を増やします。

例:

* stake: 100 DUSDC
* risk: 2x
* 実行額: 200 DUSDC相当

メリット:

* 実際の損益とリスクが一致しやすい

デメリット:

* ユーザーの残高が多く必要
* 3x時の損失も実額で大きくなる

## 9.2 Score multiplier

Predictの実行額は stake のままにして、Arena score だけに倍率をかけます。

例:

* stake: 100 DUSDC
* risk: 2x
* Predict実行額: 100 DUSDC
* score計算: 2x

メリット:

* ハッカソンMVPで安全
* 証拠金管理が不要
* UIが破綻しにくい

デメリット:

* 実損益とランキングスコアが完全には一致しない

MVPでは **Score multiplier** を推奨します。

発表時の説明:

> DEEP ARENAの1x / 2x / 3xは、Margin取引ではなくPredict戦略カードのrisk presetsです。借入、清算、利息は扱いません。

---

## 10. Payoff表示

## 10.1 Binary payoff

Directional Duel の表示例:

| Settlement | Result | 表示 |
| --- | --- | --- |
| price > strike | WIN | payout を受け取る |
| price <= strike | LOSE | entry cost を失う |

UIで表示する値:

* You pay
* You receive if correct
* Max loss
* Net profit if correct
* Net loss if wrong
* Score if correct
* Score if wrong

## 10.2 Range payoff

Range Master の表示例:

| Settlement | Result | 表示 |
| --- | --- | --- |
| lower <= price <= upper | WIN | range payout を受け取る |
| price < lower | LOSE | entry cost を失う |
| price > upper | LOSE | entry cost を失う |

実際の vertical range payoff が線形または段階的に変化する場合は、DeepBook Predict の quote / redeem preview に合わせて表示します。DEEP ARENA側で独自payoffを発明しません。

## 10.3 Hedge payoff

Hedge Master は複数legの合算で見せます。

表示するシナリオ:

* Strong up
* Slight up
* Flat
* Slight down
* Strong down

各シナリオで表示するもの:

* Main leg result
* Protection leg result
* Total payout
* Net PnL
* Arena score

---

## 11. スコア設計

DEEP ARENA は「誰が一番儲かったか」だけのランキングにしません。

評価軸:

* Profit: 実現損益
* Accuracy: 予測が当たったか
* Risk discipline: 高リスク倍率を使いすぎていないか
* Hedge quality: Hedge Masterで損失を抑えたか
* Capital efficiency: 同じstakeでどれだけ良い結果を出したか

基本式:

```txt
base_score = realized_pnl_points + accuracy_points + efficiency_points
risk_adjusted_score = base_score * risk_multiplier - penalty_points
```

penalty例:

* 3xで外した場合の追加減点
* hedgeが機能しなかった場合の減点
* expiry前に短期売却して大きく損失を出した場合の減点

MVPでは単純に始めます。

```txt
win_score = net_profit_points * risk_multiplier
lose_score = net_loss_points * risk_multiplier
```

---

## 12. ユーザーフロー

## 12.1 初回セットアップ

1. ユーザーが `/` を開く
2. Walletを接続する
3. アプリが `PredictManager` の有無を確認する
4. なければ `create_manager()` を実行する
5. quote asset を `PredictManager` に deposit する

## 12.2 戦略カード選択

1. ユーザーが `/arena` を開く
2. Directional Duel / Range Master / Hedge Master から選ぶ
3. 対象 market を選ぶ
4. expiry を選ぶ
5. strike または range を選ぶ
6. stake を入力する
7. risk multiplier を選ぶ
8. payoff preview を確認する
9. transaction を実行する

## 12.3 ポジション管理

1. ユーザーが `/portfolio` を開く
2. open positions を見る
3. live oracle / settled oracle の状態を見る
4. redeem可能なら redeem する
5. 結果が Arena score に反映される

## 12.4 ランキング

1. ユーザーが `/leaderboard` を開く
2. daily / weekly / season を切り替える
3. strategy type で絞り込む
4. score / PnL / accuracy / risk を見る

---

## 13. Next.jsページ構成

```txt
apps/web/src/app/
├── layout.tsx
├── page.tsx
├── providers.tsx
├── arena/
│   └── page.tsx
├── strategy/
│   └── [strategyType]/
│       └── page.tsx
├── portfolio/
│   └── page.tsx
├── leaderboard/
│   └── page.tsx
└── settings/
    └── page.tsx
```

---

## 14. 画面仕様

## 14.1 `/`

トップページ。

表示内容:

* DeepARENAの説明
* Predict only の明示
* Directional Duel / Range Master / Hedge Master
* Wallet connect
* Arenaへの導線

## 14.2 `/arena`

戦略カード一覧。

表示内容:

* market selector
* oracle / expiry status
* strategy cards
* recommended strike
* current price
* active rounds
* leaderboard preview

## 14.3 `/strategy/[strategyType]`

戦略作成ページ。

表示内容:

* strategy title
* market
* expiry
* strike / range
* direction
* stake
* risk multiplier
* payoff preview
* score preview
* execute button

## 14.4 `/portfolio`

自分のPredictポジション一覧。

表示内容:

* PredictManager ID
* quote balance
* open positions
* settled positions
* redeemable positions
* strategy card history
* realized PnL
* Arena score

## 14.5 `/leaderboard`

ランキング。

表示内容:

* rank
* wallet
* score
* realized PnL
* win rate
* strategy mix
* risk usage
* best trade

## 14.6 `/settings`

アカウント設定。

表示内容:

* PredictManager作成
* quote asset deposit
* quote asset withdraw
* wallet balance
* manager balance

---

## 15. フロントエンド構成

```txt
apps/web/src/
├── app/
│   ├── page.tsx
│   ├── arena/page.tsx
│   ├── strategy/[strategyType]/page.tsx
│   ├── portfolio/page.tsx
│   ├── leaderboard/page.tsx
│   └── settings/page.tsx
│
├── components/
│   ├── layout/
│   ├── wallet/
│   ├── arena/
│   ├── strategy/
│   ├── predict/
│   ├── payoff/
│   ├── leaderboard/
│   └── ui/
│
├── features/
│   ├── predict-manager/
│   ├── markets/
│   ├── strategies/
│   ├── portfolio/
│   ├── scoring/
│   └── leaderboard/
│
├── lib/
│   ├── sui/
│   ├── predict/
│   ├── payoff/
│   └── math/
│
├── config/
│   ├── packageIds.ts
│   ├── markets.ts
│   └── constants.ts
│
└── types/
    ├── predict.ts
    ├── strategy.ts
    ├── arena.ts
    └── scoring.ts
```

---

## 16. フロントエンド技術スタック

* Next.js
* TypeScript
* Tailwind CSS
* Sui TypeScript SDK
* Sui dApp Kit
* TanStack Query
* Zustand または Jotai
* Recharts

---

## 17. Moveコントラクト方針

MVPでは、DeepBook Predictの既存コントラクトを主に使います。

DEEP ARENA独自のMoveコントラクトは、必須ではありません。

必要な場合だけ、Arena score / season / strategy record を記録する軽量コントラクトを作ります。

```txt
contracts/deeparena/
├── Move.toml
└── sources/
    ├── arena.move
    ├── strategy_record.move
    ├── season.move
    ├── scoring.move
    ├── events.move
    └── errors.move
```

MVPハッカソンでは、ArenaPosition はまずフロントエンドのイベント読み取りとローカル計算で成立させてもよいです。オンチェーン記録が必要な場合だけ、以下の最小コントラクトを追加します。

---

## 18. 主要Object案

## 18.1 ArenaConfig

```move
public struct ArenaConfig has key {
    id: UID,
    admin: address,
    season_id: u64,
    paused: bool,
}
```

## 18.2 Season

```move
public struct Season has key {
    id: UID,
    season_id: u64,
    starts_at_ms: u64,
    ends_at_ms: u64,
    supported_oracles: vector<ID>,
    paused: bool,
}
```

## 18.3 ArenaPosition

```move
public struct ArenaPosition has key, store {
    id: UID,
    owner: address,
    season_id: u64,
    strategy_type: u8,
    oracle_id: ID,
    expiry_ms: u64,
    strike: u64,
    lower_strike: u64,
    upper_strike: u64,
    direction: u8,
    stake: u64,
    risk_multiplier: u8,
    opened_at_ms: u64,
    settled_at_ms: u64,
    status: u8,
}
```

`strategy_type`:

| 値 | 意味 |
| ---: | --- |
| 0 | DIRECTIONAL_DUEL |
| 1 | RANGE_MASTER |
| 2 | HEDGE_MASTER |

`direction`:

| 値 | 意味 |
| ---: | --- |
| 0 | UP |
| 1 | DOWN |
| 2 | RANGE |
| 3 | MULTI_LEG |

## 18.4 ScoreRecord

```move
public struct ScoreRecord has key, store {
    id: UID,
    owner: address,
    season_id: u64,
    position_id: ID,
    realized_pnl: i64,
    score: i64,
    risk_multiplier: u8,
    settled_at_ms: u64,
}
```

---

## 19. 主要関数案

オンチェーンにArena記録を残す場合の最小APIです。

## 19.1 戦略記録

```move
public entry fun record_position(
    season: &mut Season,
    strategy_type: u8,
    oracle_id: ID,
    expiry_ms: u64,
    strike: u64,
    lower_strike: u64,
    upper_strike: u64,
    direction: u8,
    stake: u64,
    risk_multiplier: u8,
    ctx: &mut TxContext
)
```

## 19.2 スコア記録

```move
public entry fun record_score(
    season: &mut Season,
    position: &mut ArenaPosition,
    realized_pnl: i64,
    score: i64,
    ctx: &mut TxContext
)
```

注意:

* Predictのmint/redeem自体はDeepBook Predict側で実行する。
* DEEP ARENAコントラクトは、戦略メタデータとスコアを記録するだけにする。
* ユーザー資金をDEEP ARENAコントラクトに預けない。

---

## 20. リスク制限

フロントエンドとArenaコントラクトで以下を制限します。

1. risk multiplier は 1 / 2 / 3 のみ
2. 1ポジションの最大 stake を設定する
3. 1ユーザーの同時 open positions 数を制限する
4. 1 expiry への集中を制限する
5. 対応していない oracle は拒否する
6. inactive / settled / expired oracle への mint を拒否する
7. Range Master は `lower_strike < upper_strike` を必須にする
8. Hedge Master は main leg と protection leg の合計 stake を表示する

---

## 21. イベント案

```move
public struct ArenaPositionRecorded has copy, drop {
    owner: address,
    season_id: u64,
    strategy_type: u8,
    oracle_id: ID,
    expiry_ms: u64,
    stake: u64,
    risk_multiplier: u8,
}
```

```move
public struct ArenaScoreRecorded has copy, drop {
    owner: address,
    season_id: u64,
    position_id: ID,
    realized_pnl: i64,
    score: i64,
}
```

---

## 22. データ取得

## 22.1 Sui RPC

用途:

* wallet balance取得
* PredictManager object取得
* Predict / Registry object取得
* oracle object取得
* ArenaPosition event取得
* transaction実行

## 22.2 DeepBook Predict read

用途:

* accepted quote assets
* trading pause state
* pricing parameters
* risk limits
* available withdrawal amount
* binary quote preview
* range quote preview
* manager balances
* position quantities

## 22.3 Frontend計算

用途:

* payoff preview
* combined payoff
* realized PnL
* score
* leaderboard
* risk usage
* win rate

---

## 23. 実装順

## Step 1: Predict基盤

* package IDs / object IDs 設定
* Registry read
* Predict object read
* oracle list read
* wallet connect
* PredictManager検出
* PredictManager作成

## Step 2: Manager資金操作

* quote asset balance表示
* deposit
* withdraw
* manager balance表示

## Step 3: Directional Duel

* market selector
* oracle / expiry selector
* UP / DOWN selector
* strike selector
* risk multiplier
* `get_trade_amounts()` preview
* `mint()` execution
* position表示
* `redeem()` execution

## Step 4: Arena score

* strategy metadata保存
* settled result判定
* realized PnL計算
* score計算
* leaderboard表示

## Step 5: Range Master

* lower / upper strike selector
* `get_range_trade_amounts()` preview
* `mint_range()` execution
* `redeem_range()` execution
* range payoff chart

## Step 6: Hedge Master

* main leg設定
* protection leg設定
* allocation入力
* combined payoff preview
* multi-leg execution
* hedge score

## Step 7: UI polish

* portfolio
* settled history
* strategy filters
* mobile layout
* loading / error states
* transaction status

---

## 24. MVP完了条件

DeepARENA MVPは以下を満たせば完成とします。

* ユーザーがWallet接続できる
* ユーザーがPredictManagerを作成または検出できる
* quote assetをmanagerにdepositできる
* Directional Duelを作成できる
* binary positionのpayoff previewを表示できる
* binary positionをmintできる
* open positionを確認できる
* settled positionをredeemできる
* Arena scoreを表示できる
* leaderboardを表示できる
* risk multiplierが1x / 2x / 3xに固定されている
* Spot / Margin / Copy trade / Strategy Vault がMVP外であることが明確

Range Master と Hedge Master は、時間が足りなければ preview + UI まででもよいです。ただし Directional Duel は実取引まで通すことを優先します。

---

## 25. 将来拡張

* Range Master完全対応
* Hedge Master完全対応
* season制
* tournament
* onchain leaderboard
* PLP liquidity analytics
* Predict protocol vaultへのLP供給画面
* advanced payoff chart
* strategy templates
* AI Strategy Assistant

将来も、自由入力の証拠金管理にはしません。

* 1x Normal
* 2x Aggressive
* 3x High Risk

このプリセットを維持し、ユーザーに清算価格や借入利息を直接調整させない設計にします。

---

## 26. まとめ

DeepARENA は、DeepBook Predict だけを使った戦略アリーナです。

ユーザーは、Directional Duel、Range Master、Hedge Master の戦略カードを選び、Predict position を作成します。アプリは、複雑なオプションや証拠金管理を隠し、payoff、risk multiplier、score、ranking として見せます。

MVPの勝ち筋は、SpotやMarginやVaultを広く触ることではありません。

**Predictのbinary positionを確実に動かし、満期時payoffとArena scoreで競える体験を作ることです。**

---

## 27. 参考リンク

* DeepBook Predict - Predict: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/predict
* DeepBook Predict - Predict Manager: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/predict-manager
* DeepBook Predict - Market Keys: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/market-keys
* DeepBook Predict - Oracle: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/oracle
* DeepBook Predict - Vault: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/vault
* DeepBook Predict - Registry: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/registry
