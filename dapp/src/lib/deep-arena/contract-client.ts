import type { DeepArenaClient } from "./client";
import { type DeepArenaConfig, deepArenaMockConfig } from "./config";
import { createMockDeepArenaClient } from "./mock-client";
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

        const BATCH_SIZE = 50;
        const players: PlayerSummary[] = [];
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

                    const score = readU64(stats.score, "score");
                    const managerId = readObjectId(stats.manager_id, "manager_id");

                    players.push({
                        address: playerAddress,
                        displayName: `${playerAddress.slice(0, 6)}...${playerAddress.slice(-4)}`,
                        rank: 0,
                        score: {
                            atomic: score,
                            decimals: this.config.quoteDecimals,
                            symbol: this.config.quoteSymbol,
                        },
                        deposited: {
                            atomic: readU64(stats.cumulative_cost, "cumulative_cost"),
                            decimals: this.config.quoteDecimals,
                            symbol: this.config.quoteSymbol,
                        },
                        predictManagerId: managerId,
                        isCurrentPlayer: false,
                    });
                } catch {
                    // skip unreadable entries
                }
            }
        }

        players.sort((a, b) => {
            const diff = BigInt(b.score.atomic) - BigInt(a.score.atomic);
            return diff > 0n ? 1 : diff < 0n ? -1 : 0;
        });
        players.forEach((p, i) => {
            p.rank = i + 1;
        });

        return players;
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
