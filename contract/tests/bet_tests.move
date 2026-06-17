/// bet::open_binary / claim_binary などの統合テストは
/// deepbook_predict::Predict, PredictManager, OracleSVI が必要で、
/// ベンダーパッケージのコンストラクタが public(package) のため
/// deep_arena テストから直接構築できない。
///
/// このファイルでは bet モジュールが使う算術ロジックのみを検証する:
///   - 手数料切り上げ計算（mul_div_round_up）
///   - スリッページガードの算術（cost + fee <= max_total_cost）
///   - arena::bps_denom() と fee_bps accessor の整合性
///
/// open_binary 〜 claim_binary の実フローは
/// testnet デプロイ後に PTB (Phase 4) で検証する。
#[test_only]
module deep_arena::bet_tests;

use deepbook_predict::math::mul_div_round_up;
use deep_arena::arena;

public struct DUSDC has drop {}

// ===== 手数料計算 =====

#[test]
fun test_fee_3pct_round_up() {
    // 3% 手数料。端数は切り上げ。
    assert!(mul_div_round_up(100,   300, 10_000) == 3);  // 3.000 → 3
    assert!(mul_div_round_up(1,     300, 10_000) == 1);  // 0.030 → 1 (切り上げ)
    assert!(mul_div_round_up(333,   300, 10_000) == 10); // 9.990 → 10 (切り上げ)
    assert!(mul_div_round_up(1_000, 300, 10_000) == 30); // 30.00 → 30
    assert!(mul_div_round_up(0,     300, 10_000) == 0);  // コスト 0 → 手数料 0
}

#[test]
fun test_fee_10pct_max_boundary() {
    // 上限 1000 bps = 10%
    assert!(mul_div_round_up(100, 1_000, 10_000) == 10);
}

#[test]
fun test_bps_denom_is_10000() {
    // bet.move が arena::bps_denom() を使う前提を確認。
    assert!(arena::bps_denom() == 10_000);
}

// ===== スリッページガード算術 =====

#[test]
fun test_slippage_guard_passes_at_exact_max() {
    let cost: u64 = 100;
    let fee = mul_div_round_up(cost, 300, arena::bps_denom()); // 3
    // cost + fee = 103。max_total_cost = 103 → ギリギリ通過
    assert!(cost + fee <= 103);
}

#[test]
fun test_slippage_guard_fails_one_below_max() {
    let cost: u64 = 100;
    let fee = mul_div_round_up(cost, 300, arena::bps_denom()); // 3
    // cost + fee = 103 > 102 → EExceedsMaxCost に相当する条件
    assert!(cost + fee > 102);
}

// ===== fee_bps アクセサ =====

#[test]
fun test_arena_fee_bps_accessor() {
    let ctx = &mut sui::tx_context::dummy();
    let arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    // fee_bps = 300 が正しく読めること
    assert!(arena::fee_bps(&arena) == 300);
    arena::destroy_arena_for_testing(arena);
}

// ===== player_of_manager =====

#[test]
fun test_player_of_manager_returns_correct_player() {
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    let player = @0xA1;
    let manager_id = object::id_from_address(@0xD1);
    arena::insert_player_for_testing(&mut arena, player, manager_id);

    assert!(arena::player_of_manager(&arena, manager_id) == player);
    arena::destroy_arena_for_testing(arena);
}

#[test]
#[expected_failure(abort_code = 1, location = deep_arena::arena)]
fun test_player_of_manager_aborts_for_unknown_manager() {
    let ctx = &mut sui::tx_context::dummy();
    let arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    // 未登録 manager_id → ENotPlayer (=1) で abort。
    arena::player_of_manager(&arena, object::id_from_address(@0xDEAD));
    arena::destroy_arena_for_testing(arena);
}

// ===== Top キャッシュ（オンチェーンランキング） =====

#[test]
fun test_leaderboard_orders_by_score_desc() {
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    let (pa, pb, pc) = (@0xA1, @0xB2, @0xC3);
    arena::insert_player_for_testing(&mut arena, pa, object::id_from_address(@0xD1));
    arena::insert_player_for_testing(&mut arena, pb, object::id_from_address(@0xD2));
    arena::insert_player_for_testing(&mut arena, pc, object::id_from_address(@0xD3));

    // payout のみ加算 → score = payout。A=100, B=50, C=200
    arena::update_score(&mut arena, pa, 0, 100, 0);
    arena::update_score(&mut arena, pb, 0, 50, 0);
    arena::update_score(&mut arena, pc, 0, 200, 0);

    assert!(arena::leaderboard_len(&arena) == 3);
    let (e0, _m0, s0, _, _, _) = arena::leaderboard_entry_at(&arena, 0);
    let (e1, _m1, s1, _, _, _) = arena::leaderboard_entry_at(&arena, 1);
    let (e2, _m2, s2, _, _, _) = arena::leaderboard_entry_at(&arena, 2);
    assert!(e0 == pc && s0 == 200);
    assert!(e1 == pa && s1 == 100);
    assert!(e2 == pb && s2 == 50);

    arena::destroy_arena_for_testing(arena);
}

#[test]
fun test_leaderboard_updates_existing_entry_no_duplicate() {
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    let pa = @0xA1;
    arena::insert_player_for_testing(&mut arena, pa, object::id_from_address(@0xD1));

    arena::update_score(&mut arena, pa, 0, 50, 0);  // score 50
    arena::update_score(&mut arena, pa, 0, 70, 0);  // 累計 payout 120 → score 120

    // 重複せず 1 件、最新スコア
    assert!(arena::leaderboard_len(&arena) == 1);
    let (e0, _m0, s0, _, _, _) = arena::leaderboard_entry_at(&arena, 0);
    assert!(e0 == pa && s0 == 120);

    arena::destroy_arena_for_testing(arena);
}

#[test]
fun test_leaderboard_tiebreak_by_bet_count_then_joined() {
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    let (pa, pb) = (@0xA1, @0xB2);
    arena::insert_player_for_testing(&mut arena, pa, object::id_from_address(@0xD1));
    arena::insert_player_for_testing(&mut arena, pb, object::id_from_address(@0xD2));

    // 同 score(=100)。A は 2 アクション、B は 1 アクション → bet_count 多い A が上位。
    arena::update_score(&mut arena, pa, 0, 100, 0);
    arena::update_score(&mut arena, pa, 0, 0, 0); // payout変化なし→score維持、bet_count=2
    arena::update_score(&mut arena, pb, 0, 100, 0); // bet_count=1

    let (e0, _m0, s0, c0, _, _) = arena::leaderboard_entry_at(&arena, 0);
    let (e1, _m1, s1, c1, _, _) = arena::leaderboard_entry_at(&arena, 1);
    assert!(e0 == pa && s0 == 100 && c0 == 2);
    assert!(e1 == pb && s1 == 100 && c1 == 1);

    arena::destroy_arena_for_testing(arena);
}

#[test]
fun test_admin_refresh_leaderboard_rebuilds() {
    let ctx = &mut sui::tx_context::dummy();
    let mut arena = arena::create_arena_for_testing<DUSDC>(
        object::id_from_address(@0xBB), 0, 100, 300, ctx,
    );
    let admin = arena::new_admin_cap_for_testing(ctx);
    let (pa, pb) = (@0xA1, @0xB2);
    arena::insert_player_for_testing(&mut arena, pa, object::id_from_address(@0xD1));
    arena::insert_player_for_testing(&mut arena, pb, object::id_from_address(@0xD2));

    // スコアを設定（update_score 経由でキャッシュにも入る）。
    arena::update_score(&mut arena, pa, 0, 30, 0);
    arena::update_score(&mut arena, pb, 0, 90, 0);

    // バックフィルで再構築しても順位は score 降順（B が上位）。
    arena::admin_refresh_leaderboard(&admin, &mut arena, vector[pa, pb]);
    assert!(arena::leaderboard_len(&arena) == 2);
    let (e0, _m0, s0, _, _, _) = arena::leaderboard_entry_at(&arena, 0);
    assert!(e0 == pb && s0 == 90);

    std::unit_test::destroy(admin);
    arena::destroy_arena_for_testing(arena);
}
