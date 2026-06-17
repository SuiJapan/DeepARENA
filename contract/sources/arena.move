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
use sui::{balance::Balance, clock::Clock, coin::Coin, dynamic_field as df, table::{Self, Table}};

// ===== 定数 =====

const STATUS_UPCOMING: u8 = 0;
const STATUS_ACTIVE: u8 = 1;
const STATUS_SETTLED: u8 = 2;

const MAX_FEE_BPS: u64 = 1_000; // 上限 10%
const BPS_DENOM: u64 = 10_000;

/// オンチェーンに保持するランキング上位の最大件数。
/// フロントは先頭 20 件を表示する。表示数より多めに保持して境界付近の取りこぼしを軽減する。
const LEADERBOARD_CAPACITY: u64 = 50;

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

/// ランキング上位キャッシュ用の 1 エントリ。score 降順で並べる。
public struct LeaderboardEntry has copy, drop, store {
    player: address,
    manager_id: ID,
    score: u64,
    bet_count: u64,
    cumulative_cost: u64,
    joined_at_ms: u64,
}

/// Arena の dynamic field キー。値は vector<LeaderboardEntry>（Top キャッシュ）。
/// 既存の Arena struct を変更せずに（= upgrade 互換のまま）ランキング配列を持たせるための鍵。
public struct LeaderboardKey has copy, drop, store {}

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
/// upgrade 互換のため &TxContext を維持（&mut TxContext への変更は upgrade 後に不可）。
#[allow(lint(prefer_mut_tx_context))]
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
/// permissionless な代行 CLAIM（運営キーパー）で、sender ではなく登録所有者を player とするために使う。
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

    // Top キャッシュ更新に必要な値をコピーして借用を終了させる。
    let manager_id = stats.manager_id;
    let bet_count = stats.bet_count;
    let cumulative_cost = stats.cumulative_cost;
    let joined_at_ms = stats.joined_at_ms;

    update_leaderboard(arena, player, manager_id, score, bet_count, cumulative_cost, joined_at_ms);
    score
}

/// 順位比較: a が b より上位なら true。
/// score desc → bet_count desc → cumulative_cost desc → joined_at_ms asc。
fun entry_ranks_above(a: &LeaderboardEntry, b: &LeaderboardEntry): bool {
    if (a.score != b.score) {
        a.score > b.score
    } else if (a.bet_count != b.bet_count) {
        a.bet_count > b.bet_count
    } else if (a.cumulative_cost != b.cumulative_cost) {
        a.cumulative_cost > b.cumulative_cost
    } else {
        a.joined_at_ms < b.joined_at_ms
    }
}

/// Top キャッシュ（dynamic field の vector）へ player を反映する。
/// 既存エントリを除去 → 順位位置を探索して挿入 → 容量超過分を末尾から削除。
fun update_leaderboard<Quote>(
    arena: &mut Arena<Quote>,
    player: address,
    manager_id: ID,
    score: u64,
    bet_count: u64,
    cumulative_cost: u64,
    joined_at_ms: u64,
) {
    if (!df::exists(&arena.id, LeaderboardKey {})) {
        df::add(&mut arena.id, LeaderboardKey {}, vector<LeaderboardEntry>[]);
    };
    let lb = df::borrow_mut<LeaderboardKey, vector<LeaderboardEntry>>(&mut arena.id, LeaderboardKey {});

    // 既存エントリを除去（同一 player は 1 件のみ）。
    let mut i = 0;
    let len = vector::length(lb);
    while (i < len) {
        if (vector::borrow(lb, i).player == player) {
            vector::remove(lb, i);
            break
        };
        i = i + 1;
    };

    let entry = LeaderboardEntry { player, manager_id, score, bet_count, cumulative_cost, joined_at_ms };

    // 挿入位置（entry が初めて上位になる位置）を探索。
    let mut pos = vector::length(lb);
    let mut j = 0;
    let n = vector::length(lb);
    while (j < n) {
        if (entry_ranks_above(&entry, vector::borrow(lb, j))) {
            pos = j;
            break
        };
        j = j + 1;
    };
    vector::insert(lb, entry, pos);

    // 容量超過分を末尾から削除。
    while (vector::length(lb) > LEADERBOARD_CAPACITY) {
        vector::pop_back(lb);
    };
}

/// 既存プレイヤーで Top キャッシュをバックフィルする（アップグレード直後の初期化用）。
/// players には off-chain で集めた全プレイヤーアドレスを渡す。AdminCap 必須。
/// 重複呼び出し安全（毎回クリアして再構築）。
public fun admin_refresh_leaderboard<Quote>(
    _: &AdminCap,
    arena: &mut Arena<Quote>,
    players: vector<address>,
) {
    // 既存キャッシュをクリア（無ければ作成）。
    if (!df::exists(&arena.id, LeaderboardKey {})) {
        df::add(&mut arena.id, LeaderboardKey {}, vector<LeaderboardEntry>[]);
    } else {
        let lb = df::borrow_mut<LeaderboardKey, vector<LeaderboardEntry>>(&mut arena.id, LeaderboardKey {});
        while (!vector::is_empty(lb)) {
            vector::pop_back(lb);
        };
    };

    let n = vector::length(&players);
    let mut i = 0;
    while (i < n) {
        let p = *vector::borrow(&players, i);
        if (arena.players.contains(p)) {
            let s = &arena.players[p];
            let manager_id = s.manager_id;
            let score = s.score;
            let bet_count = s.bet_count;
            let cumulative_cost = s.cumulative_cost;
            let joined_at_ms = s.joined_at_ms;
            update_leaderboard(arena, p, manager_id, score, bet_count, cumulative_cost, joined_at_ms);
        };
        i = i + 1;
    };
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

/// Top キャッシュの件数。未初期化なら 0。
public fun leaderboard_len<Quote>(arena: &Arena<Quote>): u64 {
    if (df::exists(&arena.id, LeaderboardKey {})) {
        vector::length(df::borrow<LeaderboardKey, vector<LeaderboardEntry>>(&arena.id, LeaderboardKey {}))
    } else {
        0
    }
}

/// Top キャッシュの i 番目を返す: (player, manager_id, score, bet_count, cumulative_cost, joined_at_ms)。
public fun leaderboard_entry_at<Quote>(
    arena: &Arena<Quote>,
    i: u64,
): (address, ID, u64, u64, u64, u64) {
    let lb = df::borrow<LeaderboardKey, vector<LeaderboardEntry>>(&arena.id, LeaderboardKey {});
    let e = vector::borrow(lb, i);
    (e.player, e.manager_id, e.score, e.bet_count, e.cumulative_cost, e.joined_at_ms)
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
        mut id,
        fee_vault,
        players,
        manager_to_player,
        ..
    } = arena;
    // dynamic field が残っていると object::delete が失敗するため先に除去する。
    if (df::exists(&id, LeaderboardKey {})) {
        let lb: vector<LeaderboardEntry> = df::remove(&mut id, LeaderboardKey {});
        std::unit_test::destroy(lb);
    };
    object::delete(id);
    // fee_vault に残高がある場合も unit_test::destroy で解放できる
    std::unit_test::destroy(fee_vault);
    std::unit_test::destroy(players);
    std::unit_test::destroy(manager_to_player);
}
