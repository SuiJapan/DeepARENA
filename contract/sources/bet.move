/// BET / CLAIM のユーザー向けエントリーポイント。
///
/// open_binary / open_range:
///   - アリーナ Active 検証・参加登録確認
///   - predict_adapter 経由で DeepBook Predict に mint
///   - 実コストから fee_bps % の手数料を切り上げ計算して徴収
///   - PnL スコアを更新してイベント発火
///
/// claim_binary / claim_range:
///   - settled oracle の permissionless redeem
///   - PnL スコアを更新してイベント発火（手数料は取らない）
module deep_arena::bet;

use deep_arena::{arena::{Self, Arena}, events, predict_adapter};
use deepbook_predict::{
    math::mul_div_round_up,
    oracle::OracleSVI,
    predict::Predict,
    predict_manager::PredictManager,
};
use sui::clock::Clock;

// ===== エラー =====

const EZeroQuantity: u64 = 0;
const EExceedsMaxCost: u64 = 1;

// ===== Binary =====

/// Binary 建玉を BET する。
/// max_total_cost: コスト＋手数料の上限（スリッページ保護）。
/// 超過した場合は abort する。
public fun open_binary<Quote>(
    arena: &mut Arena<Quote>,
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    quantity: u64,
    max_total_cost: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(quantity > 0, EZeroQuantity);
    arena::assert_active(arena);

    let player = ctx.sender();
    let manager_id = object::id(manager);
    arena::assert_player(arena, player, manager_id);

    // DeepBook Predict に mint。実コスト（post-trade balance 差分）を受け取る。
    let cost = predict_adapter::mint_binary<Quote>(
        predict, manager, oracle,
        oracle_id, expiry, strike, is_up,
        quantity, clock, ctx,
    );

    // 3% 手数料を切り上げ計算。
    let fee = mul_div_round_up(cost, arena::fee_bps(arena), arena::bps_denom());
    assert!(cost + fee <= max_total_cost, EExceedsMaxCost);

    // manager から手数料を引き出して arena fee_vault へ積む。
    let fee_coin = manager.withdraw<Quote>(fee, ctx);
    arena::deposit_fee(arena, fee_coin);

    // PnL スコア更新。
    let score = arena::update_score(arena, player, cost, 0, fee);

    events::emit_binary_opened(
        object::id(arena), player, manager_id,
        oracle_id, expiry, strike, is_up,
        quantity, cost, fee, score,
    );
}

/// Binary 建玉の払戻を CLAIM する。
/// settled oracle に対して permissionless で redeem し、payout を manager 残高に入れる。
/// 手数料は取らない。
public fun claim_binary<Quote>(
    arena: &mut Arena<Quote>,
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
) {
    assert!(quantity > 0, EZeroQuantity);
    // CLAIM は arena の Active チェックをしない（期限後も可）。
    // manager の登録所有者を player として解決する（sender は誰でもよい = 運営キーパー代行可）。
    let manager_id = object::id(manager);
    let player = arena::player_of_manager(arena, manager_id);

    // settled oracle を permissionless で redeem。payout が manager 残高に入る。
    let payout = predict_adapter::redeem_binary_permissionless<Quote>(
        predict, manager, oracle,
        oracle_id, expiry, strike, is_up,
        quantity, clock, ctx,
    );

    let score = arena::update_score(arena, player, 0, payout, 0);

    events::emit_binary_closed(
        object::id(arena), player, manager_id,
        oracle_id, expiry, strike, is_up,
        quantity, payout, score,
    );
}

// ===== Range =====

/// Range 建玉を BET する。Binary と同一フロー。
public fun open_range<Quote>(
    arena: &mut Arena<Quote>,
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    oracle_id: ID,
    expiry: u64,
    lower_strike: u64,
    higher_strike: u64,
    quantity: u64,
    max_total_cost: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(quantity > 0, EZeroQuantity);
    arena::assert_active(arena);

    let player = ctx.sender();
    let manager_id = object::id(manager);
    arena::assert_player(arena, player, manager_id);

    let cost = predict_adapter::mint_range<Quote>(
        predict, manager, oracle,
        oracle_id, expiry, lower_strike, higher_strike,
        quantity, clock, ctx,
    );

    let fee = mul_div_round_up(cost, arena::fee_bps(arena), arena::bps_denom());
    assert!(cost + fee <= max_total_cost, EExceedsMaxCost);

    let fee_coin = manager.withdraw<Quote>(fee, ctx);
    arena::deposit_fee(arena, fee_coin);

    let score = arena::update_score(arena, player, cost, 0, fee);

    events::emit_range_opened(
        object::id(arena), player, manager_id,
        oracle_id, expiry, lower_strike, higher_strike,
        quantity, cost, fee, score,
    );
}

// ===== Break（2 レッグ同時 BET） =====

/// ブレイクアウト BET: lower_strike の DOWN レッグと upper_strike の UP レッグを同時 mint。
/// 手数料は 2 レッグ合計コストに対して 1 回計算する。
public fun open_break<Quote>(
    arena: &mut Arena<Quote>,
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    oracle_id: ID,
    expiry: u64,
    lower_strike: u64,
    upper_strike: u64,
    quantity: u64,
    max_total_cost: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(quantity > 0, EZeroQuantity);
    arena::assert_active(arena);

    let player = ctx.sender();
    let manager_id = object::id(manager);
    arena::assert_player(arena, player, manager_id);

    // レッグ 1: lower_strike で DOWN (is_up=false)
    let cost_low = predict_adapter::mint_binary<Quote>(
        predict, manager, oracle,
        oracle_id, expiry, lower_strike, false,
        quantity, clock, ctx,
    );
    // レッグ 2: upper_strike で UP (is_up=true)
    let cost_high = predict_adapter::mint_binary<Quote>(
        predict, manager, oracle,
        oracle_id, expiry, upper_strike, true,
        quantity, clock, ctx,
    );

    let total_cost = cost_low + cost_high;
    let fee = mul_div_round_up(total_cost, arena::fee_bps(arena), arena::bps_denom());
    assert!(total_cost + fee <= max_total_cost, EExceedsMaxCost);

    let fee_coin = manager.withdraw<Quote>(fee, ctx);
    arena::deposit_fee(arena, fee_coin);

    let score = arena::update_score(arena, player, total_cost, 0, fee);

    events::emit_break_opened(
        object::id(arena), player, manager_id,
        oracle_id, expiry, lower_strike, upper_strike,
        quantity, total_cost, fee, score,
    );
}

/// ブレイクアウト CLAIM: 2 レッグそれぞれを順に redeem し合計払戻をスコア反映する。
public fun claim_break<Quote>(
    arena: &mut Arena<Quote>,
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    oracle_id: ID,
    expiry: u64,
    lower_strike: u64,
    upper_strike: u64,
    quantity: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(quantity > 0, EZeroQuantity);
    // manager の登録所有者を player として解決する（sender は誰でもよい = 運営キーパー代行可）。
    let manager_id = object::id(manager);
    let player = arena::player_of_manager(arena, manager_id);

    let payout_low = predict_adapter::redeem_binary_permissionless<Quote>(
        predict, manager, oracle,
        oracle_id, expiry, lower_strike, false,
        quantity, clock, ctx,
    );
    let payout_high = predict_adapter::redeem_binary_permissionless<Quote>(
        predict, manager, oracle,
        oracle_id, expiry, upper_strike, true,
        quantity, clock, ctx,
    );

    let total_payout = payout_low + payout_high;
    let score = arena::update_score(arena, player, 0, total_payout, 0);

    events::emit_break_closed(
        object::id(arena), player, manager_id,
        oracle_id, expiry, lower_strike, upper_strike,
        quantity, total_payout, score,
    );
}

/// Range 建玉の払戻を CLAIM する。
public fun claim_range<Quote>(
    arena: &mut Arena<Quote>,
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
) {
    assert!(quantity > 0, EZeroQuantity);
    // manager の登録所有者を player として解決する（sender は誰でもよい = 運営キーパー代行可）。
    let manager_id = object::id(manager);
    let player = arena::player_of_manager(arena, manager_id);

    let payout = predict_adapter::redeem_range<Quote>(
        predict, manager, oracle,
        oracle_id, expiry, lower_strike, higher_strike,
        quantity, clock, ctx,
    );

    let score = arena::update_score(arena, player, 0, payout, 0);

    events::emit_range_closed(
        object::id(arena), player, manager_id,
        oracle_id, expiry, lower_strike, higher_strike,
        quantity, payout, score,
    );
}
