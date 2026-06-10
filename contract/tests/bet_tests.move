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
