module deep_arena::predict_sandbox_adapter;

use deepbook_predict::plp::PLP;
use deepbook_predict::predict::{Self, Predict};
use sui::clock::Clock;
use sui::coin::Coin;

public fun supply<Quote>(
    predict: &mut Predict,
    coin: Coin<Quote>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<PLP> {
    predict::supply<Quote>(predict, coin, clock, ctx)
}

public fun withdraw<Quote>(
    predict: &mut Predict,
    lp_coin: Coin<PLP>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<Quote> {
    predict::withdraw<Quote>(predict, lp_coin, clock, ctx)
}
