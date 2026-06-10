/// Deep Arena イベント一元定義モジュール。
/// 全構造体は has copy, drop（保存なし、その場で破棄）。
/// 発火関数は public(package)：同一パッケージ内からのみ呼ぶ。
module deep_arena::events;

use sui::event;

// ===== Arena ライフサイクル =====

public struct ArenaCreated has copy, drop {
    arena_id: ID,
    predict_id: ID,
    fee_bps: u64,
    start_ms: u64,
    end_ms: u64,
}

public struct PlayerJoined has copy, drop {
    arena_id: ID,
    player: address,
    manager_id: ID,
    timestamp_ms: u64,
}

// ===== Binary 取引 =====

public struct BinaryOpened has copy, drop {
    arena_id: ID,
    player: address,
    manager_id: ID,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    quantity: u64,
    cost: u64,
    fee: u64,
    score: u64,
}

public struct BinaryClosed has copy, drop {
    arena_id: ID,
    player: address,
    manager_id: ID,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    quantity: u64,
    payout: u64,
    score: u64,
}

// ===== Range 取引 =====

public struct RangeOpened has copy, drop {
    arena_id: ID,
    player: address,
    manager_id: ID,
    oracle_id: ID,
    expiry: u64,
    lower_strike: u64,
    higher_strike: u64,
    quantity: u64,
    cost: u64,
    fee: u64,
    score: u64,
}

public struct RangeClosed has copy, drop {
    arena_id: ID,
    player: address,
    manager_id: ID,
    oracle_id: ID,
    expiry: u64,
    lower_strike: u64,
    higher_strike: u64,
    quantity: u64,
    payout: u64,
    score: u64,
}

// ===== Break 取引（2 レッグ同時 BET） =====

public struct BreakOpened has copy, drop {
    arena_id: ID,
    player: address,
    manager_id: ID,
    oracle_id: ID,
    expiry: u64,
    lower_strike: u64,
    upper_strike: u64,
    quantity: u64,
    cost: u64,      // 2 レッグ合計コスト
    fee: u64,
    score: u64,
}

public struct BreakClosed has copy, drop {
    arena_id: ID,
    player: address,
    manager_id: ID,
    oracle_id: ID,
    expiry: u64,
    lower_strike: u64,
    upper_strike: u64,
    quantity: u64,
    payout: u64,    // 2 レッグ合計払戻
    score: u64,
}

// ===== Admin =====

public struct FeesWithdrawn has copy, drop {
    arena_id: ID,
    admin: address,
    amount: u64,
}

// ===== 発火関数 =====

public(package) fun emit_arena_created(
    arena_id: ID, predict_id: ID, fee_bps: u64, start_ms: u64, end_ms: u64,
) {
    event::emit(ArenaCreated { arena_id, predict_id, fee_bps, start_ms, end_ms });
}

public(package) fun emit_player_joined(
    arena_id: ID, player: address, manager_id: ID, timestamp_ms: u64,
) {
    event::emit(PlayerJoined { arena_id, player, manager_id, timestamp_ms });
}

public(package) fun emit_binary_opened(
    arena_id: ID,
    player: address,
    manager_id: ID,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    quantity: u64,
    cost: u64,
    fee: u64,
    score: u64,
) {
    event::emit(BinaryOpened {
        arena_id, player, manager_id, oracle_id, expiry, strike,
        is_up, quantity, cost, fee, score,
    });
}

public(package) fun emit_binary_closed(
    arena_id: ID,
    player: address,
    manager_id: ID,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    quantity: u64,
    payout: u64,
    score: u64,
) {
    event::emit(BinaryClosed {
        arena_id, player, manager_id, oracle_id, expiry, strike,
        is_up, quantity, payout, score,
    });
}

public(package) fun emit_range_opened(
    arena_id: ID,
    player: address,
    manager_id: ID,
    oracle_id: ID,
    expiry: u64,
    lower_strike: u64,
    higher_strike: u64,
    quantity: u64,
    cost: u64,
    fee: u64,
    score: u64,
) {
    event::emit(RangeOpened {
        arena_id, player, manager_id, oracle_id, expiry, lower_strike,
        higher_strike, quantity, cost, fee, score,
    });
}

public(package) fun emit_range_closed(
    arena_id: ID,
    player: address,
    manager_id: ID,
    oracle_id: ID,
    expiry: u64,
    lower_strike: u64,
    higher_strike: u64,
    quantity: u64,
    payout: u64,
    score: u64,
) {
    event::emit(RangeClosed {
        arena_id, player, manager_id, oracle_id, expiry, lower_strike,
        higher_strike, quantity, payout, score,
    });
}

public(package) fun emit_break_opened(
    arena_id: ID,
    player: address,
    manager_id: ID,
    oracle_id: ID,
    expiry: u64,
    lower_strike: u64,
    upper_strike: u64,
    quantity: u64,
    cost: u64,
    fee: u64,
    score: u64,
) {
    event::emit(BreakOpened {
        arena_id, player, manager_id, oracle_id, expiry, lower_strike,
        upper_strike, quantity, cost, fee, score,
    });
}

public(package) fun emit_break_closed(
    arena_id: ID,
    player: address,
    manager_id: ID,
    oracle_id: ID,
    expiry: u64,
    lower_strike: u64,
    upper_strike: u64,
    quantity: u64,
    payout: u64,
    score: u64,
) {
    event::emit(BreakClosed {
        arena_id, player, manager_id, oracle_id, expiry, lower_strike,
        upper_strike, quantity, payout, score,
    });
}

public(package) fun emit_fees_withdrawn(arena_id: ID, admin: address, amount: u64) {
    event::emit(FeesWithdrawn { arena_id, admin, amount });
}
