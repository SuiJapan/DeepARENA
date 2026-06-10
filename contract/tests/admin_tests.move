#[test_only]
module deep_arena::admin_tests;

use deep_arena::{admin, arena};
use sui::{clock, coin, test_scenario};

public struct DUSDC has drop {}

// ===== activate / settle =====

#[test]
fun test_activate_arena_ok() {
    let ctx = &mut sui::tx_context::dummy();
    let cap = arena::new_admin_cap_for_testing(ctx);
    let mut a = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    // UPCOMING のまま assert_active は失敗するはず
    // activate 後は status が ACTIVE になる
    admin::activate_arena(&cap, &mut a);
    assert!(arena::status(&a) == 1); // STATUS_ACTIVE = 1
    std::unit_test::destroy(cap);
    arena::destroy_arena_for_testing(a);
}

#[test, expected_failure(abort_code = deep_arena::arena::EArenaNotEnded)]
fun test_settle_arena_before_end_ms_aborts() {
    let ctx = &mut sui::tx_context::dummy();
    let cap = arena::new_admin_cap_for_testing(ctx);
    let mut a = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 999_999_999_999, 300, ctx,
    );
    admin::activate_arena(&cap, &mut a);
    // clock = 0ms, end_ms = 999_999_999_999 → まだ終わっていない → abort
    let clk = clock::create_for_testing(ctx);
    admin::settle_arena(&cap, &mut a, &clk);
    clk.destroy_for_testing();
    std::unit_test::destroy(cap);
    arena::destroy_arena_for_testing(a);
}

#[test]
fun test_settle_arena_after_end_ms_ok() {
    let ctx = &mut sui::tx_context::dummy();
    let cap = arena::new_admin_cap_for_testing(ctx);
    // end_ms = 1 000 ms
    let mut a = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 1_000, 300, ctx,
    );
    admin::activate_arena(&cap, &mut a);
    // clock を 1 000 ms 以降に設定
    let mut clk = clock::create_for_testing(ctx);
    clk.set_for_testing(1_000);
    admin::settle_arena(&cap, &mut a, &clk);
    assert!(arena::status(&a) == 2); // STATUS_SETTLED = 2
    clk.destroy_for_testing();
    std::unit_test::destroy(cap);
    arena::destroy_arena_for_testing(a);
}

// ===== fee_bps =====

#[test, expected_failure(abort_code = deep_arena::arena::EFeeBpsTooHigh)]
fun test_set_fee_bps_too_high_aborts() {
    let ctx = &mut sui::tx_context::dummy();
    let cap = arena::new_admin_cap_for_testing(ctx);
    let mut a = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    admin::set_fee_bps(&cap, &mut a, 1_001); // 上限 1000 超過
    std::unit_test::destroy(cap);
    arena::destroy_arena_for_testing(a);
}

#[test]
fun test_set_fee_bps_max_ok() {
    let ctx = &mut sui::tx_context::dummy();
    let cap = arena::new_admin_cap_for_testing(ctx);
    let mut a = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    admin::set_fee_bps(&cap, &mut a, 1_000); // 上限ちょうど OK
    assert!(arena::fee_bps(&a) == 1_000);
    std::unit_test::destroy(cap);
    arena::destroy_arena_for_testing(a);
}

// ===== pause =====

#[test, expected_failure(abort_code = deep_arena::arena::EArenaPaused)]
fun test_paused_arena_blocks_active_check() {
    let ctx = &mut sui::tx_context::dummy();
    let cap = arena::new_admin_cap_for_testing(ctx);
    let mut a = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    admin::activate_arena(&cap, &mut a);
    admin::set_paused(&cap, &mut a, true);
    // paused = true → assert_active が EArenaPaused で abort
    arena::assert_active(&a);
    std::unit_test::destroy(cap);
    arena::destroy_arena_for_testing(a);
}

#[test]
fun test_unpause_allows_active_check() {
    let ctx = &mut sui::tx_context::dummy();
    let cap = arena::new_admin_cap_for_testing(ctx);
    let mut a = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    admin::activate_arena(&cap, &mut a);
    admin::set_paused(&cap, &mut a, true);
    admin::set_paused(&cap, &mut a, false);
    // paused=false かつ ACTIVE → assert_active は通過する
    arena::assert_active(&a);
    std::unit_test::destroy(cap);
    arena::destroy_arena_for_testing(a);
}

// ===== withdraw_fees =====

#[test]
fun test_withdraw_fees_ok() {
    let admin_addr = @0xA1;
    let mut scenario = test_scenario::begin(admin_addr);
    {
        let cap = arena::new_admin_cap_for_testing(test_scenario::ctx(&mut scenario));
        let mut a = arena::create_arena_for_testing<DUSDC>(
            object::id_from_address(@0xBB), 0, 100, 300,
            test_scenario::ctx(&mut scenario),
        );
        // fee_vault に 50 を直接入金（test ヘルパー経由）
        let fee_coin = coin::mint_for_testing<DUSDC>(50, test_scenario::ctx(&mut scenario));
        arena::deposit_fee(&mut a, fee_coin);
        assert!(arena::fee_vault_balance(&a) == 50);

        admin::withdraw_fees(&cap, &mut a, 50, test_scenario::ctx(&mut scenario));
        assert!(arena::fee_vault_balance(&a) == 0);

        std::unit_test::destroy(cap);
        arena::destroy_arena_for_testing(a);
    };
    test_scenario::end(scenario);
}
