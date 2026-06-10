/// AdminCap を持つ運営アドレスのみが呼べる操作を集約したモジュール。
///
/// - activate_arena : UPCOMING → ACTIVE への遷移
/// - settle_arena   : ACTIVE → SETTLED への遷移（end_ms 経過後のみ）
/// - set_fee_bps    : 手数料率変更（上限 MAX_FEE_BPS = 1000 bps）
/// - set_paused     : BET の一時停止 / 再開
/// - withdraw_fees  : fee_vault から運営への引き出し
module deep_arena::admin;

use deep_arena::{arena::{Self, AdminCap, Arena}, events};
use sui::clock::Clock;

// ===== Arena ライフサイクル =====

/// UPCOMING → ACTIVE に移行する。
public fun activate_arena<Quote>(_: &AdminCap, arena: &mut Arena<Quote>) {
    arena::set_active(arena);
}

/// ACTIVE → SETTLED に移行する。end_ms を過ぎていない場合は abort（EArenaNotEnded）。
public fun settle_arena<Quote>(
    _: &AdminCap,
    arena: &mut Arena<Quote>,
    clock: &Clock,
) {
    arena::set_settled(arena, clock);
}

// ===== 手数料管理 =====

/// fee_vault から amount を引き出し、呼び出し元（運営）に転送する。
/// amount が fee_vault 残高を超える場合は SUI ランタイムが abort する。
public fun withdraw_fees<Quote>(
    _: &AdminCap,
    arena: &mut Arena<Quote>,
    amount: u64,
    ctx: &mut TxContext,
) {
    let admin = ctx.sender();
    let coin = arena::withdraw_fee(arena, amount, ctx);
    events::emit_fees_withdrawn(object::id(arena), admin, amount);
    transfer::public_transfer(coin, admin);
}

/// 手数料率を変更する。bps > 1000 (10%) の場合は abort（EFeeBpsTooHigh）。
public fun set_fee_bps<Quote>(
    _: &AdminCap,
    arena: &mut Arena<Quote>,
    bps: u64,
) {
    arena::set_fee_bps(arena, bps);
}

// ===== Pause =====

/// BET を一時停止 (paused=true) または再開 (paused=false) する。
/// pause 中は open_binary / open_range / open_break が EArenaPaused で abort する。
public fun set_paused<Quote>(
    _: &AdminCap,
    arena: &mut Arena<Quote>,
    paused: bool,
) {
    arena::set_paused(arena, paused);
}
