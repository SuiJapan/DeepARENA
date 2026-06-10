/// Deep Arena の唯一の DeepBook Predict 接続点（薄いアダプタ層）。
/// このモジュールだけが deepbook_predict を直接 import する。
/// bet / arena などは本モジュールの public(package) 関数経由でのみ Predict を操作する。
module deep_arena::predict_adapter;

use deepbook_predict::{
    market_key,
    oracle::OracleSVI,
    predict::{Self, Predict},
    predict_manager::PredictManager,
    range_key,
};
use sui::clock::Clock;

// ===== Binary (mint / redeem / preview) =====

/// Binary 建玉の (mint_cost, redeem_payout) 見積もりを返す。
/// 実際の mint は行わないため状態変化なし。
public(package) fun preview_binary(
    predict: &Predict,
    oracle: &OracleSVI,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    quantity: u64,
    clock: &Clock,
): (u64, u64) {
    let key = market_key::new(oracle_id, expiry, strike, is_up);
    predict::get_trade_amounts(predict, oracle, key, quantity, clock)
}

/// Binary 建玉を mint する。
/// manager から実際に引き落とされたコスト（post-trade 価格）を返す。
public(package) fun mint_binary<Quote>(
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    quantity: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    let key = market_key::new(oracle_id, expiry, strike, is_up);
    let balance_before = manager.balance<Quote>();
    predict::mint<Quote>(predict, manager, oracle, key, quantity, clock, ctx);
    balance_before - manager.balance<Quote>()
}

/// 決済済み（settled）Binary 建玉を permissionless で redeem する。
/// manager 残高に加算された払戻額を返す。
public(package) fun redeem_binary_permissionless<Quote>(
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    quantity: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    let key = market_key::new(oracle_id, expiry, strike, is_up);
    let balance_before = manager.balance<Quote>();
    predict::redeem_permissionless<Quote>(predict, manager, oracle, key, quantity, clock, ctx);
    manager.balance<Quote>() - balance_before
}

// ===== Range (mint / redeem / preview) =====

/// Range 建玉の (mint_cost, redeem_payout) 見積もりを返す。
public(package) fun preview_range(
    predict: &Predict,
    oracle: &OracleSVI,
    oracle_id: ID,
    expiry: u64,
    lower_strike: u64,
    higher_strike: u64,
    quantity: u64,
    clock: &Clock,
): (u64, u64) {
    let key = range_key::new(oracle_id, expiry, lower_strike, higher_strike);
    predict::get_range_trade_amounts(predict, oracle, key, quantity, clock)
}

/// Range 建玉を mint する。実コストを返す。
public(package) fun mint_range<Quote>(
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    oracle_id: ID,
    expiry: u64,
    lower_strike: u64,
    higher_strike: u64,
    quantity: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    let key = range_key::new(oracle_id, expiry, lower_strike, higher_strike);
    let balance_before = manager.balance<Quote>();
    predict::mint_range<Quote>(predict, manager, oracle, key, quantity, clock, ctx);
    balance_before - manager.balance<Quote>()
}

/// Range 建玉を redeem する（live / settled 両対応）。払戻額を返す。
public(package) fun redeem_range<Quote>(
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    oracle_id: ID,
    expiry: u64,
    lower_strike: u64,
    higher_strike: u64,
    quantity: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    let key = range_key::new(oracle_id, expiry, lower_strike, higher_strike);
    let balance_before = manager.balance<Quote>();
    predict::redeem_range<Quote>(predict, manager, oracle, key, quantity, clock, ctx);
    manager.balance<Quote>() - balance_before
}

// ===== Manager helpers =====

/// manager の quote 残高を読む（bet / arena 内でスコア更新に使用）。
public(package) fun manager_balance<Quote>(manager: &PredictManager): u64 {
    manager.balance<Quote>()
}
