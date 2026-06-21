import type { DeepArenaConfig } from "@/lib/deep-arena/config";

/**
 * predict の redeem イベント（PositionRedeemed / RangeRedeemed）を集計し、
 * manager_id → 払戻合計(atomic) を返す「差分キャッシュ型インデックス」。
 *
 * ランキングのスコア（獲得額）は、redeem の実行経路（本人 / キーパー / predict UI）に
 * 関わらず必ず emit される redeem イベントの payout を合算して求める。オンチェーンの
 * cumulative_payout は bet::claim_* 経由分しか加算されず欠損するため使えない。
 *
 * 毎リクエストで全件を読むと公開 RPC のレート制限（429）に当たるため、サーバープロセス内に
 * 集計結果と「最後に取り込んだ最新イベント位置」を保持し、2 回目以降は新着イベントだけを読む。
 */

const TESTNET_RPC = "https://fullnode.testnet.sui.io";

const PAGE_SIZE = 50;
// 初回バックフィルの安全上限（PAGE_SIZE * このページ数 まで遡る）。
const BACKFILL_MAX_PAGES = 200;
// 差分取り込みの上限。これを超えても既知の最新に到達しない場合は二重計上を避けるため失敗扱い。
const INCREMENTAL_MAX_PAGES = 40;
// ページ間ディレイ（バースト緩和）と 429 リトライ設定。
const PAGE_DELAY_MS = 150;
const MAX_RPC_RETRIES = 4;

interface EventTypeState {
    /** 前回取り込み時点で最も新しかったイベントの一意 ID（"txDigest:eventSeq"）。未取得は null。 */
    seenLatestId: string | null;
}

interface IndexState {
    payoutByManager: Map<string, bigint>;
    perType: Map<string, EventTypeState>;
}

let committed: IndexState | null = null;
let refreshInFlight: Promise<Map<string, bigint>> | null = null;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(TESTNET_RPC, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            cache: "no-store",
        });
        if (res.status === 429 && attempt < MAX_RPC_RETRIES) {
            await delay(300 * 2 ** attempt);
            continue;
        }
        if (!res.ok) throw new Error(`Sui RPC ${method} failed: ${res.status}`);
        const payload = (await res.json()) as unknown;
        if (!isRecord(payload) || !("result" in payload)) {
            throw new Error(`Invalid Sui RPC response for ${method}`);
        }
        return payload.result;
    }
}

function eventId(item: Record<string, unknown>): string | null {
    const id = isRecord(item.id) ? item.id : null;
    if (!id) return null;
    const txDigest = typeof id.txDigest === "string" ? id.txDigest : null;
    const seq = id.eventSeq;
    const seqText = typeof seq === "string" ? seq : typeof seq === "number" ? String(seq) : null;
    if (!txDigest || seqText === null) return null;
    return `${txDigest}:${seqText}`;
}

function readU64(value: unknown): bigint | null {
    const text = typeof value === "number" ? String(value) : value;
    if (typeof text !== "string" || !/^\d+$/.test(text)) return null;
    return BigInt(text);
}

function readObjectIdString(value: unknown): string | null {
    if (typeof value === "string" && value.length > 0) return value;
    if (isRecord(value)) {
        if (typeof value.id === "string") return value.id;
        if (typeof value.bytes === "string") return value.bytes;
    }
    return null;
}

/**
 * 1 イベント型を新しい順に読み、payout を payoutByManager に加算する。
 * - 初回（seenLatestId == null）: 最古まで（BACKFILL_MAX_PAGES 上限）全件を集計。
 * - 差分: 既知の最新イベントに到達するまでの新着のみ集計。上限内に到達しなければ throw。
 * 完了時、type 内で最も新しかったイベント ID を nextState.seenLatestId に書き戻す。
 */
async function refreshType(
    eventType: string,
    predictObjectId: string,
    nextState: EventTypeState,
    payoutByManager: Map<string, bigint>,
): Promise<void> {
    const isInitial = nextState.seenLatestId === null;
    const maxPages = isInitial ? BACKFILL_MAX_PAGES : INCREMENTAL_MAX_PAGES;
    const previousLatestId = nextState.seenLatestId;

    let cursor: unknown = null;
    let newLatestId: string | null = null;
    let reachedKnown = false;

    for (let page = 0; page < maxPages; page++) {
        const result = await rpc("suix_queryEvents", [
            { MoveEventType: eventType },
            cursor,
            PAGE_SIZE,
            true, // descending: 新しい順
        ]);
        if (!isRecord(result) || !Array.isArray(result.data)) break;

        for (const item of result.data) {
            if (!isRecord(item)) continue;
            const id = eventId(item);
            // 全体で最初（=最新）に見たイベントを次回の基準として記録。
            if (newLatestId === null && id) newLatestId = id;
            // 差分時、既知の最新に到達したら以降は処理済みなので停止。
            if (!isInitial && id !== null && id === previousLatestId) {
                reachedKnown = true;
                break;
            }
            const parsed = item.parsedJson ?? item.parsed_json;
            if (!isRecord(parsed)) continue;
            // このアリーナの predict に紐づくイベントのみ集計（共有 predict 対策）。
            if (readObjectIdString(parsed.predict_id) !== predictObjectId) continue;
            const managerId = readObjectIdString(parsed.manager_id);
            const payout = readU64(parsed.payout);
            if (!managerId || payout === null) continue;
            payoutByManager.set(managerId, (payoutByManager.get(managerId) ?? 0n) + payout);
        }

        if (reachedKnown) break;
        if (result.hasNextPage !== true) break;
        cursor = result.nextCursor;
        if (PAGE_DELAY_MS > 0) await delay(PAGE_DELAY_MS);
    }

    // 差分で既知の最新に到達できなかった場合、取りこぼし/二重計上を避けるため失敗とする。
    if (!isInitial && !reachedKnown) {
        throw new Error(`Incremental redeem index out of range for ${eventType}`);
    }

    // 新着が無ければ newLatestId は前回と同じ。イベントが 1 件も無ければ null のまま維持。
    if (newLatestId !== null) nextState.seenLatestId = newLatestId;
}

async function doRefresh(config: DeepArenaConfig): Promise<Map<string, bigint>> {
    const eventTypes = [
        `${config.predictPackageId}::predict::PositionRedeemed`,
        `${config.predictPackageId}::predict::RangeRedeemed`,
    ];

    // 確定済み状態のコピー上で集計し、全型成功時のみコミットする（途中失敗で二重計上しない）。
    const base = committed ? new Map(committed.payoutByManager) : new Map<string, bigint>();
    const perTypeNext = new Map<string, EventTypeState>();

    for (const eventType of eventTypes) {
        const prev = committed?.perType.get(eventType);
        const nextState: EventTypeState = { seenLatestId: prev?.seenLatestId ?? null };
        await refreshType(eventType, config.predictObjectId, nextState, base);
        perTypeNext.set(eventType, nextState);
    }

    committed = { payoutByManager: base, perType: perTypeNext };
    return new Map(base);
}

/**
 * manager_id → 払戻合計(atomic, bigint) を返す。初回は全件バックフィル、以降は差分更新。
 * 同時呼び出しは 1 本の更新処理に集約する。
 */
export function getRedeemPayoutByManager(config: DeepArenaConfig): Promise<Map<string, bigint>> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = doRefresh(config).finally(() => {
        refreshInFlight = null;
    });
    return refreshInFlight;
}
