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
            1_001, // 上限 1000 超過
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
        object::id_from_address(@0xBB),
        0,
        100,
        300,
        ctx,
    );
    arena::assert_active(&arena); // status = UPCOMING → abort
    arena::destroy_arena_for_testing(arena);
}

// ===== set_fee_bps =====

#[test, expected_failure(abort_code = deep_arena::arena::EFeeBpsTooHigh)]
fun test_set_fee_bps_too_high_aborts() {
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB),
        0,
        100,
        300,
        ctx,
    );
    arena::set_fee_bps(&mut arena, 1_001); // 上限超過 → abort
    arena::destroy_arena_for_testing(arena);
}

#[test]
fun test_set_fee_bps_max_ok() {
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB),
        0,
        100,
        300,
        ctx,
    );
    arena::set_fee_bps(&mut arena, 1_000); // ちょうど上限 = OK
    assert!(arena::fee_bps(&arena) == 1_000);
    arena::destroy_arena_for_testing(arena);
}

// ===== update_score（PnL 計算） =====

#[test]
fun test_update_score_profit() {
    let player = @0xC1;
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB),
        0,
        100,
        300,
        ctx,
    );

    let manager_id = object::id_from_address(@0xD1);
    arena::insert_player_for_testing(&mut arena, player, manager_id);

    // deposited=100, balance=150, payout=0, fee=3
    // score = (150 + 0) - 100 = 50
    let score = arena::update_score(&mut arena, player, 150, 100, 0, 3);
    assert!(score == 50);
    assert!(arena::player_score(&arena, player) == 50);

    arena::destroy_arena_for_testing(arena);
}

#[test]
fun test_update_score_loss_clamps_to_zero() {
    let player = @0xC2;
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB),
        0,
        100,
        300,
        ctx,
    );
    let manager_id = object::id_from_address(@0xD2);
    arena::insert_player_for_testing(&mut arena, player, manager_id);

    // deposited=100, balance=40, payout=0 → PnL = 40 - 100 = -60 → score = 0
    let score = arena::update_score(&mut arena, player, 40, 100, 0, 3);
    assert!(score == 0);

    arena::destroy_arena_for_testing(arena);
}

#[test]
fun test_update_score_with_payout() {
    let player = @0xC3;
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB),
        0,
        100,
        300,
        ctx,
    );
    let manager_id = object::id_from_address(@0xD3);
    arena::insert_player_for_testing(&mut arena, player, manager_id);

    // 1回目: deposited=100, balance=80, payout=0, fee=3 → score=0(clamp)
    arena::update_score(&mut arena, player, 80, 100, 0, 3);

    // 2回目: deposited_delta=0, balance=180, payout_delta=100
    // cumulative_deposited=100, cumulative_payout=100
    // score = (180 + 100) - 100 = 180
    let score = arena::update_score(&mut arena, player, 180, 0, 100, 0);
    assert!(score == 180);

    arena::destroy_arena_for_testing(arena);
}

// ===== double join =====

#[test, expected_failure(abort_code = deep_arena::arena::EAlreadyJoined)]
fun test_double_join_aborts() {
    let player = @0xE1;
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB),
        0,
        100,
        300,
        ctx,
    );
    let manager_id = object::id_from_address(@0xD4);
    // 1回目は成功
    arena::insert_player_for_testing(&mut arena, player, manager_id);
    // 2回目は EAlreadyJoined で abort
    arena::insert_player_for_testing(&mut arena, player, manager_id);
    arena::destroy_arena_for_testing(arena);
}
