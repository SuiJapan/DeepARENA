module deep_arena::plp_sandbox;

use deep_arena::predict_sandbox_adapter;
use deepbook_predict::plp::PLP;
use deepbook_predict::predict::Predict;
use sui::clock::Clock;
use sui::coin::Coin;
use sui::event;

const EZeroAmount: u64 = 0;

public struct SandboxLiquidityProvided has copy, drop {
    provider: address,
    predict_id: ID,
    quote_amount: u64,
    plp_amount: u64,
}

public struct SandboxLiquidityWithdrawn has copy, drop {
    provider: address,
    predict_id: ID,
    plp_amount: u64,
    quote_amount: u64,
}

public fun provide_liquidity<Quote>(
    predict: &mut Predict,
    coin: Coin<Quote>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<PLP> {
    let quote_amount = coin.value();
    assert!(quote_amount > 0, EZeroAmount);

    let plp_coin = predict_sandbox_adapter::supply<Quote>(predict, coin, clock, ctx);
    let plp_amount = plp_coin.value();
    let provider = ctx.sender();
    let predict_id = object::id(predict);

    event::emit(SandboxLiquidityProvided {
        provider,
        predict_id,
        quote_amount,
        plp_amount,
    });

    plp_coin
}

public fun withdraw_liquidity<Quote>(
    predict: &mut Predict,
    lp_coin: Coin<PLP>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<Quote> {
    let plp_amount = lp_coin.value();
    assert!(plp_amount > 0, EZeroAmount);

    let quote_coin = predict_sandbox_adapter::withdraw<Quote>(predict, lp_coin, clock, ctx);
    let quote_amount = quote_coin.value();
    let provider = ctx.sender();
    let predict_id = object::id(predict);

    event::emit(SandboxLiquidityWithdrawn {
        provider,
        predict_id,
        plp_amount,
        quote_amount,
    });

    quote_coin
}
