import type { DeepArenaClient } from "./client";
import { type DeepArenaConfig, deepArenaMockConfig } from "./config";
import { createMockDeepArenaClient } from "./mock-client";
import {
    binaryKey,
    computePnl,
    type OpenedContribution,
    type RedeemContribution,
    rangeKey,
} from "./pnl-calculator";
import type {
    ActionPreview,
    ArenaStatus,
    ArenaSummary,
    BinaryActionInput,
    BinaryMarket,
    EventKind,
    EventLog,
    MockActionResult,
    PlayerSummary,
    PlpState,
    RangeActionInput,
    RangeMarket,
    VaultState,
} from "./types";

const TESTNET_RPC = "https://fullnode.testnet.sui.io";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Invalid ${field}: expected non-empty string`);
    }
    return value;
}

function readU64(value: unknown, field: string): string {
    const text = typeof value === "number" ? String(value) : value;
    if (typeof text !== "string" || !/^\d+$/.test(text)) {
        throw new Error(`Invalid ${field}: expected u64 string, got ${JSON.stringify(value)}`);
    }
    return text;
}

function readObjectId(value: unknown, field: string): string {
    if (isRecord(value)) {
        if ("id" in value) return readString(value.id, `${field}.id`);
        if ("bytes" in value) return readString(value.bytes, `${field}.bytes`);
    }
    return readString(value, field);
}

/** Reads struct fields, handling both { fields: {...} } and flat { key: value } forms. */
function readFields(value: unknown, contextField: string): Record<string, unknown> {
    if (!isRecord(value)) throw new Error(`${contextField} is not a record`);
    if (isRecord(value.fields)) return value.fields;
    return value;
}

function statusToArenaStatus(status: unknown): ArenaStatus {
    if (status === "1" || status === 1) return "active";
    if (status === "2" || status === 2) return "settled";
    return "upcoming";
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(TESTNET_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        cache: "no-store",
    });
    if (!res.ok) throw new Error(`Sui RPC ${method} failed: ${res.status}`);
    const payload = (await res.json()) as unknown;
    if (!isRecord(payload) || !("result" in payload)) {
        throw new Error(`Invalid Sui RPC response for ${method}`);
    }
    return payload.result;
}

async function getObjectFields(objectId: string): Promise<Record<string, unknown>> {
    const result = await rpc("sui_getObject", [objectId, { showContent: true, showType: true }]);
    if (!isRecord(result)) throw new Error(`Object ${objectId} not found`);
    const data = result.data;
    if (!isRecord(data)) throw new Error(`Object ${objectId} has no data`);
    const content = data.content;
    return readFields(content, `${objectId}.content`);
}

interface DynamicFieldEntry {
    name: unknown;
    objectId: string;
}

async function multiGetObjectsFields(
    objectIds: string[],
): Promise<Array<Record<string, unknown> | null>> {
    if (objectIds.length === 0) return [];
    const result = await rpc("sui_multiGetObjects", [
        objectIds,
        { showContent: true, showType: true },
    ]);
    if (!Array.isArray(result)) return objectIds.map(() => null);
    return result.map((item) => {
        if (!isRecord(item)) return null;
        const data = isRecord(item.data) ? item.data : null;
        if (!data) return null;
        const content = isRecord(data.content) ? data.content : null;
        if (!content) return null;
        return isRecord(content.fields) ? content.fields : null;
    });
}

async function listDynamicFields(parentId: string): Promise<DynamicFieldEntry[]> {
    const entries: DynamicFieldEntry[] = [];
    let cursor: unknown = null;
    for (let page = 0; page < 20; page++) {
        const result = await rpc("suix_getDynamicFields", [parentId, cursor, 50]);
        if (!isRecord(result) || !Array.isArray(result.data)) break;
        for (const item of result.data) {
            if (!isRecord(item)) continue;
            const objectId = readString(item.objectId, "dynamicField.objectId");
            entries.push({ name: item.name, objectId });
        }
        if (!result.hasNextPage) break;
        cursor = result.nextCursor;
    }
    return entries;
}

// ===== PnL 再構築用イベント取得（方針A） =====

const EVENT_PAGE_SIZE = 50;
// *Opened は arena 利用者のみ。redeem は Predict 全ユーザー横断のため母数が大きい。
const OPENED_EVENT_MAX_PAGES = 40;
const REDEEM_EVENT_MAX_PAGES = 100;

const EVENT_QUERY_MAX_ATTEMPTS = 3;
const EVENT_QUERY_RETRY_BASE_DELAY_MS = 400;

function delayMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 1 ページ取得（429・一時障害はリトライ）。 */
async function queryEventsPageWithRetry(eventType: string, cursor: unknown): Promise<unknown> {
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= EVENT_QUERY_MAX_ATTEMPTS; attempt++) {
        try {
            return await rpc("suix_queryEvents", [
                { MoveEventType: eventType },
                cursor,
                EVENT_PAGE_SIZE,
                false,
            ]);
        } catch (caught) {
            lastErr = caught;
            if (attempt < EVENT_QUERY_MAX_ATTEMPTS) {
                await delayMs(EVENT_QUERY_RETRY_BASE_DELAY_MS * attempt);
            }
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`queryEvents failed for ${eventType}`);
}

/** 単一 MoveEventType を昇順ページングで全件取得する。 */
async function queryAllEvents(eventType: string, maxPages: number): Promise<unknown[]> {
    const items: unknown[] = [];
    let cursor: unknown = null;
    for (let page = 0; page < maxPages; page++) {
        const result = await queryEventsPageWithRetry(eventType, cursor);
        if (!isRecord(result) || !Array.isArray(result.data)) break;
        items.push(...result.data);
        if (!result.hasNextPage) break;
        cursor = result.nextCursor;
    }
    return items;
}

function parsedJsonOf(item: unknown): Record<string, unknown> | null {
    if (!isRecord(item)) return null;
    const parsed = item.parsedJson ?? item.parsed_json;
    return isRecord(parsed) ? parsed : null;
}

function eventTimestampMs(item: unknown): number {
    if (!isRecord(item)) return 0;
    const value = item.timestampMs;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    return 0;
}

function eventDigest(item: unknown): string {
    if (!isRecord(item)) return "";
    const id = item.id;
    if (isRecord(id) && typeof id.txDigest === "string") return id.txDigest;
    return "";
}

export class ContractDeepArenaClient implements DeepArenaClient {
    private readonly config: DeepArenaConfig;
    private readonly fallback: DeepArenaClient;

    constructor(config: DeepArenaConfig = deepArenaMockConfig) {
        this.config = config;
        this.fallback = createMockDeepArenaClient();
    }

    async getArena(): Promise<ArenaSummary> {
        const fields = await getObjectFields(this.config.arenaObjectId);

        const status = statusToArenaStatus(fields.status);
        const startMs = Number(readU64(fields.start_ms, "start_ms"));
        const endMs = Number(readU64(fields.end_ms, "end_ms"));
        const playerCount = Number(readU64(fields.player_count, "player_count"));

        // Balance<T> can serialize as a u64 string (0) or as { fields: { value: "N" } }
        let feeVaultBalance = "0";
        if (isRecord(fields.fee_vault)) {
            const fvf = readFields(fields.fee_vault, "fee_vault");
            try {
                feeVaultBalance = readU64(fvf.value, "fee_vault.value");
            } catch {
                feeVaultBalance = "0";
            }
        } else {
            try {
                feeVaultBalance = readU64(fields.fee_vault, "fee_vault");
            } catch {
                feeVaultBalance = "0";
            }
        }

        const predictId = readObjectId(fields.predict_id, "predict_id");

        return {
            id: this.config.arenaObjectId,
            name: "Deep Arena Season 1",
            status,
            startMs,
            endMs,
            participantCount: playerCount,
            prizePool: {
                atomic: feeVaultBalance,
                decimals: this.config.quoteDecimals,
                symbol: this.config.quoteSymbol,
            },
            entryAmount: {
                atomic: "0",
                decimals: this.config.quoteDecimals,
                symbol: this.config.quoteSymbol,
            },
            quoteCoinType: this.config.quoteCoinType,
            predictObjectId: predictId,
        };
    }

    async listPlayers(): Promise<PlayerSummary[]> {
        const arenaFields = await getObjectFields(this.config.arenaObjectId);

        // Table<address, PlayerStats> → { fields: { id: { id: "0xTABLE_ID" }, size: "N" } }
        const playersTableRaw = arenaFields.players;
        const playersTableFields = isRecord(playersTableRaw)
            ? readFields(playersTableRaw, "arena.players")
            : null;
        if (!playersTableFields) return [];

        const tableId = readObjectId(playersTableFields.id, "players.tableId");

        const dynamicFields = await listDynamicFields(tableId);
        if (dynamicFields.length === 0) return [];

        // 各プレイヤーの (address, managerId) を収集。
        // fallbackScore / fallbackCost はオンチェーンの値（PnL 再構築が失敗した場合のみ使う）。
        interface PlayerEntry {
            address: string;
            managerId: string;
            fallbackScore: string;
            fallbackCost: string;
        }
        const BATCH_SIZE = 50;
        const entries: PlayerEntry[] = [];
        for (let i = 0; i < dynamicFields.length; i += BATCH_SIZE) {
            const batch = dynamicFields.slice(i, i + BATCH_SIZE);
            const ids = batch.map((e) => e.objectId);
            const batchFields = await multiGetObjectsFields(ids);
            for (const objFields of batchFields) {
                if (!objFields) continue;
                try {
                    // Dynamic field: { name: address, value: PlayerStats }
                    const playerAddress = readString(objFields.name, "player.address");
                    const statsRaw = objFields.value;
                    const stats = isRecord(statsRaw) ? readFields(statsRaw, "player.stats") : null;
                    if (!stats) continue;
                    const managerId = readObjectId(stats.manager_id, "manager_id");
                    let fallbackScore = "0";
                    let fallbackCost = "0";
                    try {
                        fallbackScore = readU64(stats.score, "score");
                    } catch {
                        // 読めなければ 0 のまま
                    }
                    try {
                        fallbackCost = readU64(stats.cumulative_cost, "cumulative_cost");
                    } catch {
                        // 読めなければ 0 のまま
                    }
                    entries.push({
                        address: playerAddress,
                        managerId,
                        fallbackScore,
                        fallbackCost,
                    });
                } catch {
                    // skip unreadable entries
                }
            }
        }
        if (entries.length === 0) return [];

        // 方針A: 確定イベントから PnL を再構築する（manager_id 小文字キー）。
        // 重いイベントスキャンが失敗・上限超過しても、ランキング自体は必ず表示する
        // （オンチェーン score へフォールバック）。
        let pnlByManager: Awaited<ReturnType<typeof this.computePnlByManager>> | null = null;
        try {
            pnlByManager = await this.computePnlByManager();
        } catch (caught) {
            console.error("PnL reconstruction failed; falling back to on-chain score:", caught);
            pnlByManager = null;
        }

        const players: PlayerSummary[] = entries.map((entry) => {
            const result = pnlByManager?.get(entry.managerId.toLowerCase());
            const scoreAtomic = result ? result.pnl.toString() : entry.fallbackScore;
            const costAtomic = result ? result.cost.toString() : entry.fallbackCost;
            return {
                address: entry.address,
                displayName: `${entry.address.slice(0, 6)}...${entry.address.slice(-4)}`,
                rank: 0,
                score: {
                    // 負値もそのまま（符号付き文字列）。
                    atomic: scoreAtomic,
                    decimals: this.config.quoteDecimals,
                    symbol: this.config.quoteSymbol,
                },
                deposited: {
                    atomic: costAtomic,
                    decimals: this.config.quoteDecimals,
                    symbol: this.config.quoteSymbol,
                },
                predictManagerId: entry.managerId,
                isCurrentPlayer: false,
            };
        });

        players.sort((a, b) => {
            const diff = BigInt(b.score.atomic) - BigInt(a.score.atomic);
            return diff > 0n ? 1 : diff < 0n ? -1 : 0;
        });
        players.forEach((p, i) => {
            p.rank = i + 1;
        });

        return players;
    }

    /**
     * 確定イベントから manager 単位の PnL を再構築する（方針A）。
     * 戻り値のキーは manager_id（小文字）。
     */
    private async computePnlByManager() {
        const { deepArenaPackageId, deepArenaPreviousPackageIds, predictPackageId, arenaObjectId } =
            this.config;

        const arenaPkgIds = [...new Set([deepArenaPackageId, ...deepArenaPreviousPackageIds])];

        // *Opened（旧+新パッケージ × 3 種）と redeem（Predict × 2 種）を並列取得。
        const openedQueries = arenaPkgIds.flatMap((pkg) =>
            (["BinaryOpened", "RangeOpened", "BreakOpened"] as const).map((kind) => ({
                pkg,
                kind,
                type: `${pkg}::events::${kind}`,
            })),
        );
        const redeemQueries = (["PositionRedeemed", "RangeRedeemed"] as const).map((kind) => ({
            kind,
            type: `${predictPackageId}::predict::${kind}`,
        }));

        const [openedResults, redeemResults] = await Promise.all([
            Promise.all(
                openedQueries.map(async (q) => ({
                    kind: q.kind,
                    items: await queryAllEvents(q.type, OPENED_EVENT_MAX_PAGES),
                })),
            ),
            Promise.all(
                redeemQueries.map(async (q) => ({
                    kind: q.kind,
                    items: await queryAllEvents(q.type, REDEEM_EVENT_MAX_PAGES),
                })),
            ),
        ]);

        const opened: OpenedContribution[] = [];
        for (const { kind, items } of openedResults) {
            for (const item of items) {
                const parsed = parsedJsonOf(item);
                if (!parsed) continue;
                try {
                    if (readObjectId(parsed.arena_id, "arena_id") !== arenaObjectId) continue;
                    const managerId = readObjectId(parsed.manager_id, "manager_id").toLowerCase();
                    const oracleId = readObjectId(parsed.oracle_id, "oracle_id");
                    const expiry = BigInt(readU64(parsed.expiry, "expiry"));
                    const quantity = BigInt(readU64(parsed.quantity, "quantity"));
                    const cost = BigInt(readU64(parsed.cost, "cost"));
                    const fee = BigInt(readU64(parsed.fee, "fee"));

                    if (kind === "BinaryOpened") {
                        const strike = BigInt(readU64(parsed.strike, "strike"));
                        const isUp = parsed.is_up === true;
                        opened.push({
                            managerId,
                            cost,
                            fee,
                            binary: [
                                { keyStr: binaryKey(oracleId, expiry, strike, isUp), quantity },
                            ],
                            range: [],
                        });
                    } else if (kind === "RangeOpened") {
                        const lower = BigInt(readU64(parsed.lower_strike, "lower_strike"));
                        const higher = BigInt(readU64(parsed.higher_strike, "higher_strike"));
                        opened.push({
                            managerId,
                            cost,
                            fee,
                            binary: [],
                            range: [
                                { keyStr: rangeKey(oracleId, expiry, lower, higher), quantity },
                            ],
                        });
                    } else {
                        // BreakOpened: lower_strike を DOWN、upper_strike を UP の 2 binary レッグへ。
                        const lower = BigInt(readU64(parsed.lower_strike, "lower_strike"));
                        const upper = BigInt(readU64(parsed.upper_strike, "upper_strike"));
                        opened.push({
                            managerId,
                            cost,
                            fee,
                            binary: [
                                { keyStr: binaryKey(oracleId, expiry, lower, false), quantity },
                                { keyStr: binaryKey(oracleId, expiry, upper, true), quantity },
                            ],
                            range: [],
                        });
                    }
                } catch {
                    // skip unreadable event
                }
            }
        }

        const redeemed: RedeemContribution[] = [];
        for (const { kind, items } of redeemResults) {
            for (const item of items) {
                const parsed = parsedJsonOf(item);
                if (!parsed) continue;
                try {
                    const managerId = readObjectId(parsed.manager_id, "manager_id").toLowerCase();
                    const oracleId = readObjectId(parsed.oracle_id, "oracle_id");
                    const expiry = BigInt(readU64(parsed.expiry, "expiry"));
                    const quantity = BigInt(readU64(parsed.quantity, "quantity"));
                    const payout = BigInt(readU64(parsed.payout, "payout"));
                    const timestampMs = eventTimestampMs(item);
                    const tieBreak = eventDigest(item);

                    if (kind === "PositionRedeemed") {
                        const strike = BigInt(readU64(parsed.strike, "strike"));
                        const isUp = parsed.is_up === true;
                        redeemed.push({
                            managerId,
                            kind: "binary",
                            keyStr: binaryKey(oracleId, expiry, strike, isUp),
                            quantity,
                            payout,
                            timestampMs,
                            tieBreak,
                        });
                    } else {
                        const lower = BigInt(readU64(parsed.lower_strike, "lower_strike"));
                        const higher = BigInt(readU64(parsed.higher_strike, "higher_strike"));
                        redeemed.push({
                            managerId,
                            kind: "range",
                            keyStr: rangeKey(oracleId, expiry, lower, higher),
                            quantity,
                            payout,
                            timestampMs,
                            tieBreak,
                        });
                    }
                } catch {
                    // skip unreadable event
                }
            }
        }

        return computePnl(opened, redeemed);
    }

    async listBinaryMarkets(): Promise<BinaryMarket[]> {
        return this.fallback.listBinaryMarkets();
    }

    async listRangeMarkets(): Promise<RangeMarket[]> {
        return this.fallback.listRangeMarkets();
    }

    async listEvents(): Promise<EventLog[]> {
        const { deepArenaPackageId, arenaObjectId } = this.config;
        const eventTypes: Array<{ type: string; kind: EventKind; title: string }> = [
            {
                type: `${deepArenaPackageId}::events::PlayerJoined`,
                kind: "player-joined",
                title: "Player joined arena",
            },
            {
                type: `${deepArenaPackageId}::events::BinaryOpened`,
                kind: "binary-opened",
                title: "Binary position opened",
            },
            {
                type: `${deepArenaPackageId}::events::RangeOpened`,
                kind: "range-opened",
                title: "Range position opened",
            },
            {
                type: `${deepArenaPackageId}::events::BreakOpened`,
                kind: "range-opened",
                title: "Break position opened",
            },
        ];

        const allEvents: EventLog[] = [];

        await Promise.all(
            eventTypes.map(async ({ type, kind, title }) => {
                try {
                    const result = await rpc("suix_queryEvents", [
                        { MoveEventType: type },
                        null,
                        20,
                        true,
                    ]);
                    if (!isRecord(result) || !Array.isArray(result.data)) return;

                    for (const item of result.data) {
                        if (!isRecord(item)) continue;
                        const parsed = item.parsedJson ?? item.parsed_json;
                        if (!isRecord(parsed)) continue;

                        try {
                            const itemArenaId = readObjectId(parsed.arena_id, "arena_id");
                            if (itemArenaId !== arenaObjectId) continue;

                            const player = readString(parsed.player, "player");
                            const timestampMs =
                                typeof item.timestampMs === "string"
                                    ? Number(item.timestampMs)
                                    : typeof item.timestampMs === "number"
                                      ? item.timestampMs
                                      : Date.now();

                            let detail = `${player.slice(0, 6)}...${player.slice(-4)}`;
                            if (kind === "binary-opened" && isRecord(parsed)) {
                                const direction = parsed.is_up ? "UP" : "DOWN";
                                const cost = readU64(parsed.cost, "cost");
                                detail += ` opened ${direction} for ${cost} ${this.config.quoteSymbol}`;
                            } else if (kind === "range-opened") {
                                const cost = readU64(parsed.cost, "cost");
                                detail += ` opened position for ${cost} ${this.config.quoteSymbol}`;
                            } else {
                                detail += " joined the arena";
                            }

                            const idRecord = isRecord(item.id) ? item.id : null;
                            const eventId = idRecord
                                ? `${readString(idRecord.txDigest, "txDigest")}-${String(idRecord.eventSeq)}`
                                : `${type}-${timestampMs}`;

                            allEvents.push({
                                id: eventId,
                                kind,
                                title,
                                detail,
                                actor: player,
                                timestampMs,
                                isMock: false,
                            });
                        } catch {
                            // skip malformed event entries
                        }
                    }
                } catch {
                    // skip unavailable event types
                }
            }),
        );

        allEvents.sort((a, b) => b.timestampMs - a.timestampMs);
        return allEvents.slice(0, 30);
    }

    async previewBinary(input: BinaryActionInput): Promise<ActionPreview> {
        return this.fallback.previewBinary(input);
    }

    async openBinaryMock(input: BinaryActionInput): Promise<MockActionResult> {
        return this.fallback.openBinaryMock(input);
    }

    async previewRange(input: RangeActionInput): Promise<ActionPreview> {
        return this.fallback.previewRange(input);
    }

    async openRangeMock(input: RangeActionInput): Promise<MockActionResult> {
        return this.fallback.openRangeMock(input);
    }

    async getVaultState(): Promise<VaultState> {
        return this.fallback.getVaultState();
    }

    async getPlpState(): Promise<PlpState> {
        return this.fallback.getPlpState();
    }
}
