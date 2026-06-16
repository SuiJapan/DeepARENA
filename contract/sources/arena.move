/// Deep Arena アリーナ本体モジュール。
///
/// Arena<Quote>: シーズン制の共有オブジェクト。参加登録・手数料保管・PnL スコア管理を担う。
/// AdminCap: 運営専用の能力オブジェクト。create_arena / 手数料引き出し / 料率変更に必要。
///
/// スコア定義（PnL）:
///   score = (manager.balance + cumulative_payout) - cumulative_deposited
///   = 実現損益（入金額を超えた純増減）を u64 で表現。
///   アンダーフロー防止: pnl が負の場合は 0 を格納する。
module deep_arena::arena;

use deepbook_predict::predict_manager::PredictManager;
use deep_arena::events;
use sui::{balance::Balance, clock::Clock, coin::Coin, table::{Self, Table}};

// ===== 定数 =====

const STATUS_UPCOMING: u8 = 0;
const STATUS_ACTIVE: u8 = 1;
const STATUS_SETTLED: u8 = 2;

const MAX_FEE_BPS: u64 = 1_000; // 上限 10%
const BPS_DENOM: u64 = 10_000;

// ===== エラー =====

const EArenaNotActive: u64 = 0;
const ENotPlayer: u64 = 1;
const EManagerMismatch: u64 = 2;
const EAlreadyJoined: u64 = 3;
const ENotManagerOwner: u64 = 4;
const EFeeBpsTooHigh: u64 = 5;
const EArenaNotEnded: u64 = 6;
const EArenaPaused: u64 = 7;

// ===== 構造体 =====

/// 運営専用能力オブジェクト。create_arena・admin 操作に必要。
public struct AdminCap has key, store {
    id: UID,
}

/// プレイヤーごとの統計。PnL ベースのスコアを保持する。
public struct PlayerStats has store {
    manager_id: ID,
    /// 純取引損益スコア: max(0, cumulative_payout - cumulative_cost - cumulative_fee_paid)
    /// 外部入金に左右されない「取引だけの純損益」を計測する。
    score: u64,
    cumulative_cost: u64,       // BET コストの累計（手数料除く）
    cumulative_payout: u64,     // CLAIM 払戻の累計
    cumulative_fee_paid: u64,   // 支払手数料の累計
    bet_count: u64,
    joined_at_ms: u64,
}

/// シーズン制アリーナ共有オブジェクト。
public struct Arena<phantom Quote> has key {
    id: UID,
    predict_id: ID,
    status: u8,
    start_ms: u64,
    end_ms: u64,
    fee_bps: u64,
    paused: bool,
    fee_vault: Balance<Quote>,
    players: Table<address, PlayerStats>,
    manager_to_player: Table<ID, address>,
    player_count: u64,
}

// ===== パッケージ初期化 =====

fun init(ctx: &mut TxContext) {
    let admin_cap = AdminCap { id: object::new(ctx) };
    transfer::transfer(admin_cap, ctx.sender());
}

// ===== 公開関数（AdminCap 必須） =====

/// 新しいシーズンのアリーナを作成して共有する。
/// AdminCap を持つ運営アドレスのみ実行可能。
public fun create_arena<Quote>(
    _: &AdminCap,
    predict_id: ID,
    start_ms: u64,
    end_ms: u64,
    fee_bps: u64,
    ctx: &mut TxContext,
) {
    assert!(fee_bps <= MAX_FEE_BPS, EFeeBpsTooHigh);

    let arena = Arena<Quote> {
        id: object::new(ctx),
        predict_id,
        status: STATUS_UPCOMING,
        start_ms,
        end_ms,
        fee_bps,
        paused: false,
        fee_vault: sui::balance::zero<Quote>(),
        players: table::new(ctx),
        manager_to_player: table::new(ctx),
        player_count: 0,
    };

    let arena_id = object::id(&arena);
    events::emit_arena_created(arena_id, predict_id, fee_bps, start_ms, end_ms);
    transfer::share_object(arena);
}

// ===== 公開関数（ユーザー） =====

/// アリーナに参加登録する。
/// 参加者自身の PredictManager を紐付ける。同一 manager は 1 アリーナに 1 回のみ登録可。
public fun join_arena<Quote>(
    arena: &mut Arena<Quote>,
    manager: &PredictManager,
    clock: &Clock,
    ctx: &TxContext,
) {
    let player = ctx.sender();
    assert!(manager.owner() == player, ENotManagerOwner);

    let manager_id = object::id(manager);
    assert!(!arena.players.contains(player), EAlreadyJoined);
    assert!(!arena.manager_to_player.contains(manager_id), EAlreadyJoined);

    let now_ms = clock.timestamp_ms();
    arena.players.add(player, PlayerStats {
        manager_id,
        score: 0,
        cumulative_cost: 0,
        cumulative_payout: 0,
        cumulative_fee_paid: 0,
        bet_count: 0,
        joined_at_ms: now_ms,
    });
    arena.manager_to_player.add(manager_id, player);
    arena.player_count = arena.player_count + 1;

    events::emit_player_joined(object::id(arena), player, manager_id, now_ms);
}

// ===== Public(package) 関数（bet / admin からのみ呼ぶ） =====

/// アリーナが Active かつ pause されていないことを検証する。
public(package) fun assert_active<Quote>(arena: &Arena<Quote>) {
    assert!(arena.status == STATUS_ACTIVE, EArenaNotActive);
    assert!(!arena.paused, EArenaPaused);
}

/// プレイヤーが登録済みかつ manager ID が一致することを検証する。
public(package) fun assert_player<Quote>(
    arena: &Arena<Quote>,
    player: address,
    manager_id: ID,
) {
    assert!(arena.players.contains(player), ENotPlayer);
    assert!(arena.players[player].manager_id == manager_id, EManagerMismatch);
}

/// manager_id からそのマネージャーを登録したプレイヤーのアドレスを解決する。
/// 未登録の manager_id の場合は ENotPlayer で abort する。
public(package) fun player_of_manager<Quote>(
    arena: &Arena<Quote>,
    manager_id: ID,
): address {
    assert!(arena.manager_to_player.contains(manager_id), ENotPlayer);
    arena.manager_to_player[manager_id]
}

/// PnL スコアを更新する。BET 時は cost_delta+fee_paid を渡し payout_delta=0。
/// CLAIM 時は payout_delta を渡し cost_delta=fee_paid=0。
///
/// score = max(0, cumulative_payout - cumulative_cost - cumulative_fee_paid)
/// 外部入金に左右されない純取引損益。
public(package) fun update_score<Quote>(
    arena: &mut Arena<Quote>,
    player: address,
    cost_delta: u64,
    payout_delta: u64,
    fee_paid: u64,
): u64 {
    let stats = &mut arena.players[player];
    stats.cumulative_cost = stats.cumulative_cost + cost_delta;
    stats.cumulative_payout = stats.cumulative_payout + payout_delta;
    stats.cumulative_fee_paid = stats.cumulative_fee_paid + fee_paid;
    stats.bet_count = stats.bet_count + 1;

    let total_spent = stats.cumulative_cost + stats.cumulative_fee_paid;
    let score = if (stats.cumulative_payout > total_spent) {
        stats.cumulative_payout - total_spent
    } else {
        0
    };
    stats.score = score;
    score
}

/// 手数料を fee_vault に積む。
public(package) fun deposit_fee<Quote>(arena: &mut Arena<Quote>, coin: Coin<Quote>) {
    arena.fee_vault.join(coin.into_balance());
}

/// fee_vault から指定額を取り出す（admin::withdraw_fees から呼ぶ）。
public(package) fun withdraw_fee<Quote>(
    arena: &mut Arena<Quote>,
    amount: u64,
    ctx: &mut TxContext,
): Coin<Quote> {
    arena.fee_vault.split(amount).into_coin(ctx)
}

/// fee_vault の現在残高を返す。
public(package) fun fee_vault_balance<Quote>(arena: &Arena<Quote>): u64 {
    arena.fee_vault.value()
}

/// アリーナを Active 状態に移行する（AdminCap で呼ぶ）。
public(package) fun set_active<Quote>(arena: &mut Arena<Quote>) {
    arena.status = STATUS_ACTIVE;
}

/// BET を一時停止 / 再開する（AdminCap で呼ぶ）。
public(package) fun set_paused<Quote>(arena: &mut Arena<Quote>, paused: bool) {
    arena.paused = paused;
}

/// アリーナを Settled 状態に移行する。end_ms 経過後のみ可。
public(package) fun set_settled<Quote>(arena: &mut Arena<Quote>, clock: &Clock) {
    assert!(clock.timestamp_ms() >= arena.end_ms, EArenaNotEnded);
    arena.status = STATUS_SETTLED;
}

/// fee_bps を変更する。上限 MAX_FEE_BPS を超えたら abort。
public(package) fun set_fee_bps<Quote>(arena: &mut Arena<Quote>, bps: u64) {
    assert!(bps <= MAX_FEE_BPS, EFeeBpsTooHigh);
    arena.fee_bps = bps;
}

// ===== Accessor =====

public fun fee_bps<Quote>(arena: &Arena<Quote>): u64 { arena.fee_bps }
public fun predict_id<Quote>(arena: &Arena<Quote>): ID { arena.predict_id }
public fun status<Quote>(arena: &Arena<Quote>): u8 { arena.status }
public fun player_count<Quote>(arena: &Arena<Quote>): u64 { arena.player_count }
public fun is_paused<Quote>(arena: &Arena<Quote>): bool { arena.paused }
public fun bps_denom(): u64 { BPS_DENOM }

public fun player_score<Quote>(arena: &Arena<Quote>, player: address): u64 {
    if (arena.players.contains(player)) {
        arena.players[player].score
    } else {
        0
    }
}

public fun player_stats<Quote>(arena: &Arena<Quote>, player: address): (u64, u64, u64, u64, u64) {
    let s = &arena.players[player];
    (s.score, s.cumulative_cost, s.cumulative_payout, s.cumulative_fee_paid, s.bet_count)
}

public fun manager_id_of<Quote>(arena: &Arena<Quote>, player: address): ID {
    arena.players[player].manager_id
}

// ===== テスト専用ヘルパー =====

#[test_only]
public fun new_admin_cap_for_testing(ctx: &mut TxContext): AdminCap {
    AdminCap { id: object::new(ctx) }
}

#[test_only]
public fun create_arena_for_testing<Quote>(
    predict_id: ID,
    start_ms: u64,
    end_ms: u64,
    fee_bps: u64,
    ctx: &mut TxContext,
): Arena<Quote> {
    Arena<Quote> {
        id: object::new(ctx),
        predict_id,
        status: STATUS_UPCOMING,
        start_ms,
        end_ms,
        fee_bps,
        paused: false,
        fee_vault: sui::balance::zero<Quote>(),
        players: table::new(ctx),
        manager_to_player: table::new(ctx),
        player_count: 0,
    }
}

#[test_only]
public fun insert_player_for_testing<Quote>(
    arena: &mut Arena<Quote>,
    player: address,
    manager_id: ID,
) {
    assert!(!arena.players.contains(player), EAlreadyJoined);
    assert!(!arena.manager_to_player.contains(manager_id), EAlreadyJoined);
    arena.players.add(player, PlayerStats {
        manager_id,
        score: 0,
        cumulative_cost: 0,
        cumulative_payout: 0,
        cumulative_fee_paid: 0,
        bet_count: 0,
        joined_at_ms: 0,
    });
    arena.manager_to_player.add(manager_id, player);
    arena.player_count = arena.player_count + 1;
}

#[test_only]
public fun destroy_arena_for_testing<Quote>(arena: Arena<Quote>) {
    let Arena {
        id,
        fee_vault,
        players,
        manager_to_player,
        ..
    } = arena;
    object::delete(id);
    // fee_vault に残高がある場合も unit_test::destroy で解放できる
    std::unit_test::destroy(fee_vault);
    std::unit_test::destroy(players);
    std::unit_test::destroy(manager_to_player);
}
