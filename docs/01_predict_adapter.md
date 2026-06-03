# 01_predict_adapter（DeepBook Predict連携コア）

このモジュールは Deep Arena が自作する Move パッケージの中で、外部プロトコル DeepBook Predict への唯一の窓口（薄いアダプタ層）です。

## 1. 確定仕様（Sui公式ドキュメント由来 / Testnet）

DeepBook Predict は有効期限ベースの予測市場プロトコルです。Binary（二者択一）と Vertical Range（範囲）の建玉を、オラクル価格に対して mint / redeem でき、LPはquote資産をVaultへ供給して PLP シェアを受け取ります。

### 環境情報（predict-testnet-4-16）

| 項目 | 値 |
|------|-----|
| Network | Testnet |
| Predict パッケージ | 0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138 |
| Predict registry | 0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64 |
| Predict object（共有オブジェクト） | 0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a |
| quote資産（現行） | DUSDC 0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC（decimals 6） |
| PLP coin type | 0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138::plp::PLP |
| 公開サーバ | https://predict-server.testnet.mystenlabs.com |

## 2. DeepBook Predict の構成要素

- **Predict**: トップレベルの共有オブジェクト。Vault残高、価格・リスク設定、quote資産の許可リスト、オラクルのstrikeグリッド、PLP treasury cap を保持。
- **PredictManager**: ユーザーごとの共有アカウント。内部に DeepBook の `BalanceManager` を持ち、預けたquote残高と、Binary建玉数量・Range数量をテーブルで管理。
- **OracleSVI**: 1つの原資産×1つの満期ごとの市場状態。spot / forward / SVIパラメータ / ライフサイクル状態 / 決済価格を保持。
- **Vault**: 流動性とエクスポージャの状態機械。受入quote資産、mark-to-market負債、最大ペイアウトを管理。

## 3. キー設計（重要）

- **Binary（二者択一）**: `(oracle_id, expiry, strike, is_up)` で識別。`is_up` は「決済価格が strike を上回ったら払う」方向。逆方向（down）は同じ oracle/expiry/strike で `is_up` を反転したもの。
- **Vertical Range（範囲）**: `(oracle_id, expiry, lower_strike, higher_strike)` で識別。決済価格が `(lower, higher]` に入ったとき払う、単一の有界商品として価格付けされる。

## 4. オラクルのライフサイクル

1. **Inactive**: 生成済みだが未有効化。
2. **Active**: 満期前。spot/forward/SVI更新を受け付け、mint可能。
3. **Pending settlement**: 満期到達、まだ満期後の初回価格未受信。
4. **Settled**: 満期後初回価格で決済価格が確定。以降の価格/SVI更新は不可。

mint は Active（live）オラクルが必須。redeem は live でも settled でも可。

## 5. Deep Arena 側の設計方針

- **薄いアダプタに徹する**: 価格計算・SVI・リスク判定は DeepBook Predict 本体に委譲し、Deep Arena は呼び出しの集約とイベント発火のみ行う。
- **quote資産はジェネリック化**: `Quote` 型パラメータで受け取り、当面は DUSDC を渡す。Mainnetで別資産に差し替え可能にする。
- **Predict object / package ID は環境設定として外出し**: ハードコードせず、デプロイ時の設定で注入する。
- **arena/binary/range/plp_vault は本モジュールの公開関数のみ呼ぶ**: 直接 deepbook_predict を import させない。

## 6. 実装インターフェース

predict_adapter が提供する主要な関数：

- `create_manager(ctx)` - PredictManager を作成
- `deposit<Quote>(manager, coin, ctx)` - Manager へ quote 資産を預け入れ
- `withdraw_from_manager<Quote>(manager, amount, ctx)` - Manager から quote 資産を引き出し
- `supply<Quote>(predict, coin, clock, ctx)` - quote 資産を Vault へ供給し PLP を受け取り
- `withdraw<Quote>(predict, lp_coin, clock, ctx)` - PLP を burn して quote 資産を引き出し
- `mint_binary<Quote>(predict, manager, oracle, expiry, strike, is_up, quantity, clock, ctx)` - Binary 建玉を mint
- `redeem_binary<Quote>(predict, manager, oracle, expiry, strike, is_up, quantity, clock, ctx)` - Binary 建玉を redeem
- `redeem_binary_permissionless<Quote>(predict, manager, oracle, expiry, strike, is_up, quantity, clock, ctx)` - settled 済みを誰でも redeem
- `mint_range<Quote>(predict, manager, oracle, expiry, lower_strike, higher_strike, quantity, clock, ctx)` - Range 建玉を mint
- `redeem_range<Quote>(predict, manager, oracle, expiry, lower_strike, higher_strike, quantity, clock, ctx)` - Range 建玉を redeem
- `preview_binary(predict, oracle, expiry, strike, is_up, quantity, clock)` - Binary の (mint_cost, redeem_payout) を見積もり
- `preview_range(predict, oracle, expiry, lower_strike, higher_strike, quantity, clock)` - Range の (mint_cost, redeem_payout) を見積もり

---

*Issue #7 参照: Deep Arena 開発計画・ロードマップ*
