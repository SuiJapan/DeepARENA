#[test_only]
module deep_arena::arena_tests;

use deep_arena::arena;
use sui::test_scenario;

/// テスト用コイン型
public struct DUSDC has drop {}

// ===== create_arena =====

#[test]
fun test_create_arena_ok() {
    let admin = @0xA1;
    let mut scenario = test_scenario::begin(admin);
    {
        let cap = arena::new_admin_cap_for_testing(test_scenario::ctx(&mut scenario));
        arena::create_arena<DUSDC>(
            &cap,
            object::id_from_address(@0xBB),
            1_000,
            61 * 24 * 3600 * 1_000,
            300,
            test_scenario::ctx(&mut scenario),
        );
        std::unit_test::destroy(cap);
    };
    test_scenario::end(scenario);
}

#[test, expected_failure(abort_code = deep_arena::arena::EFeeBpsTooHigh)]
fun test_create_arena_fee_bps_too_high_aborts() {
    let admin = @0xA2;
    let mut scenario = test_scenario::begin(admin);
    {
        let cap = arena::new_admin_cap_for_testing(test_scenario::ctx(&mut scenario));
        arena::create_arena<DUSDC>(
            &cap,
            object::id_from_address(@0xBB),
            1_000,
            1_000 + 1,
            1_001,
            test_scenario::ctx(&mut scenario),
        );
        std::unit_test::destroy(cap);
    };
    test_scenario::end(scenario);
}

// ===== assert_active =====

#[test, expected_failure(abort_code = deep_arena::arena::EArenaNotActive)]
fun test_assert_active_upcoming_aborts() {
    let ctx = &mut sui::tx_context::dummy();
    let arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    arena::assert_active(&arena);
    arena::destroy_arena_for_testing(arena);
}

// ===== set_fee_bps =====

#[test, expected_failure(abort_code = deep_arena::arena::EFeeBpsTooHigh)]
fun test_set_fee_bps_too_high_aborts() {
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    arena::set_fee_bps(&mut arena, 1_001);
    arena::destroy_arena_for_testing(arena);
}

#[test]
fun test_set_fee_bps_max_ok() {
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    arena::set_fee_bps(&mut arena, 1_000);
    assert!(arena::fee_bps(&arena) == 1_000);
    arena::destroy_arena_for_testing(arena);
}

// ===== update_score（純取引 PnL 計算）=====

#[test]
fun test_update_score_profit() {
    let player = @0xC1;
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    let manager_id = object::id_from_address(@0xD1);
    arena::insert_player_for_testing(&mut arena, player, manager_id);

    // BET: cost=100, fee=3 → total_spent=103
    arena::update_score(&mut arena, player, 100, 0, 3);
    // score = max(0, 0 - 103) = 0
    assert!(arena::player_score(&arena, player) == 0);

    // CLAIM: payout=150 → cumulative_payout=150
    // score = max(0, 150 - 103) = 47
    let score = arena::update_score(&mut arena, player, 0, 150, 0);
    assert!(score == 47);
    assert!(arena::player_score(&arena, player) == 47);

    arena::destroy_arena_for_testing(arena);
}

#[test]
fun test_update_score_loss_clamps_to_zero() {
    let player = @0xC2;
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    let manager_id = object::id_from_address(@0xD2);
    arena::insert_player_for_testing(&mut arena, player, manager_id);

    // BET: cost=100, fee=3 → total_spent=103
    arena::update_score(&mut arena, player, 100, 0, 3);
    // CLAIM: payout=50 → score = max(0, 50 - 103) = 0
    let score = arena::update_score(&mut arena, player, 0, 50, 0);
    assert!(score == 0);

    arena::destroy_arena_for_testing(arena);
}

#[test]
fun test_update_score_multiple_bets() {
    let player = @0xC3;
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    let manager_id = object::id_from_address(@0xD3);
    arena::insert_player_for_testing(&mut arena, player, manager_id);

    // BET1: cost=80, fee=2
    arena::update_score(&mut arena, player, 80, 0, 2);
    // BET2: cost=60, fee=2
    arena::update_score(&mut arena, player, 60, 0, 2);
    // total_spent = (80+60) + (2+2) = 144
    // CLAIM1: payout=100 → cumulative_payout=100, score=max(0,100-144)=0
    arena::update_score(&mut arena, player, 0, 100, 0);
    // CLAIM2: payout=80 → cumulative_payout=180, score=max(0,180-144)=36
    let score = arena::update_score(&mut arena, player, 0, 80, 0);
    assert!(score == 36);

    arena::destroy_arena_for_testing(arena);
}

// ===== double join =====

#[test, expected_failure(abort_code = deep_arena::arena::EAlreadyJoined)]
fun test_double_join_aborts() {
    let player = @0xE1;
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    let manager_id = object::id_from_address(@0xD4);
    arena::insert_player_for_testing(&mut arena, player, manager_id);
    arena::insert_player_for_testing(&mut arena, player, manager_id); // EAlreadyJoined
    arena::destroy_arena_for_testing(arena);
}
