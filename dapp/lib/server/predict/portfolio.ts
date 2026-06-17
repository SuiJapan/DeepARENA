import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { type NextRequest, NextResponse } from "next/server";
import {
    type MintedPositionEvent,
    POSITION_MINTED_EVENT_TYPE,
    POSITION_REDEEMED_EVENT_TYPE,
    RANGE_MINTED_EVENT_TYPE,
    type RangeMintEvent,
    type RedeemedPositionEvent,
    readManagerBalance,
    readPositionMintedEvent,
    readPositionRedeemedEvent,
    readRangeMintedEvent,
} from "@/lib/predict-binary/client";
import { PREDICT_BINARY_CONFIG } from "@/lib/predict-binary/config";
import { mapWithConcurrency } from "@/lib/utils/concurrent";

const TX_PAGES_MAX = 4;
const TX_PAGE_SIZE = 50;
const MANAGER_BALANCE_CONCURRENCY = 5;

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 200;

const suiClient = new SuiJsonRpcClient({
    network: PREDICT_BINARY_CONFIG.network,
    url: PREDICT_BINARY_CONFIG.fullnodeJsonRpcUrl,
});

// --- TTL cache ---

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

class TtlCache<T> {
    private readonly entries = new Map<string, CacheEntry<T>>();

    get(key: string): T | null {
        const entry = this.entries.get(key);
        if (!entry || Date.now() > entry.expiresAt) {
            this.entries.delete(key);
            return null;
        }
        return entry.value;
    }

    set(key: string, value: T): void {
        if (this.entries.size >= CACHE_MAX_ENTRIES) {
            const firstKey = this.entries.keys().next().value;
            if (firstKey !== undefined) {
                this.entries.delete(firstKey);
            }
        }
        this.entries.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    }
}

const portfolioCache = new TtlCache<PortfolioData>();

// --- BigInt serialization ---

type Serialized<T> = T extends bigint
    ? string
    : T extends Array<infer U>
      ? Array<Serialized<U>>
      : T extends object
        ? { [K in keyof T]: Serialized<T[K]> }
        : T;

function serializeBigInts<T>(value: T): Serialized<T> {
    if (typeof value === "bigint") {
        return value.toString() as Serialized<T>;
    }
    if (Array.isArray(value)) {
        return value.map(serializeBigInts) as Serialized<T>;
    }
    if (value !== null && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            result[k] = serializeBigInts(v);
        }
        return result as Serialized<T>;
    }
    return value as Serialized<T>;
}

// --- Helpers ---

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTypeName(value: string): string {
    return value.toLowerCase().replace(/^0x/, "");
}

function readOwnerAddress(value: unknown): string | null {
    if (typeof value === "string") return value;
    if (!isRecord(value)) return null;
    const addressOwner = value.AddressOwner;
    return typeof addressOwner === "string" ? addressOwner : null;
}

function hasPositiveWalletDusdcBalanceChange(
    balanceChanges: unknown,
    walletAddress: string,
): boolean {
    if (!Array.isArray(balanceChanges)) return false;
    return balanceChanges.some((change) => {
        if (!isRecord(change)) return false;
        const owner = readOwnerAddress(change.owner);
        const coinType = typeof change.coinType === "string" ? change.coinType : null;
        const amount = typeof change.amount === "string" ? change.amount : null;
        return (
            owner?.toLowerCase() === walletAddress.toLowerCase() &&
            coinType === PREDICT_BINARY_CONFIG.quoteCoinType &&
            amount !== null &&
            BigInt(amount) > 0n
        );
    });
}

function isTxSuccess(block: unknown): boolean {
    if (!isRecord(block)) return false;
    const effects = isRecord(block.effects) ? block.effects : null;
    const status = effects && isRecord(effects.status) ? effects.status.status : null;
    return status === "success";
}

function readTxTimestampMs(block: unknown): number | null {
    if (!isRecord(block)) return null;
    const value = block.timestampMs;
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) return Number(value);
    return null;
}

// --- TX block fetching ---

interface PortfolioData {
    minted: MintedPositionEvent[];
    rangeMinted: RangeMintEvent[];
    redeemed: RedeemedPositionEvent[];
    claimedKeys: string[];
    managerBalances: Record<string, string>;
    pagesInfo: {
        mintedPagesRead: number;
        mintedReachedLimit: boolean;
        rangePagesRead: number;
        rangeReachedLimit: boolean;
        redeemedPagesRead: number;
        redeemedReachedLimit: boolean;
    };
}

async function fetchTxBlocks(walletAddress: string): Promise<{
    blocks: unknown[];
    pagesRead: number;
    reachedLimit: boolean;
}> {
    let cursor: unknown = null;
    const allBlocks: unknown[] = [];

    for (let page = 0; page < TX_PAGES_MAX; page++) {
        const response = await fetch(PREDICT_BINARY_CONFIG.fullnodeJsonRpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: page + 1,
                method: "suix_queryTransactionBlocks",
                params: [
                    {
                        filter: { FromAddress: walletAddress },
                        options: {
                            showEvents: true,
                            showBalanceChanges: true,
                            showEffects: true,
                        },
                    },
                    cursor,
                    TX_PAGE_SIZE,
                    true,
                ],
            }),
        });
        if (!response.ok) {
            throw new Error(`suix_queryTransactionBlocks failed: ${response.status}`);
        }
        const payload = (await response.json()) as unknown;
        if (
            !isRecord(payload) ||
            !isRecord(payload.result) ||
            !Array.isArray(payload.result.data)
        ) {
            throw new Error("Invalid suix_queryTransactionBlocks response");
        }
        allBlocks.push(...payload.result.data);
        if (payload.result.hasNextPage !== true) {
            return { blocks: allBlocks, pagesRead: page + 1, reachedLimit: false };
        }
        cursor = payload.result.nextCursor;
    }
    return { blocks: allBlocks, pagesRead: TX_PAGES_MAX, reachedLimit: true };
}

function parseTxBlocksToPortfolio(
    blocks: unknown[],
    walletAddress: string,
): {
    minted: MintedPositionEvent[];
    rangeMinted: RangeMintEvent[];
    redeemed: RedeemedPositionEvent[];
    claimedKeys: string[];
} {
    const minted: MintedPositionEvent[] = [];
    const rangeMinted: RangeMintEvent[] = [];
    const redeemed: RedeemedPositionEvent[] = [];
    const claimedKeys: string[] = [];

    for (const block of blocks) {
        if (!isRecord(block) || !isTxSuccess(block)) continue;

        const events = Array.isArray(block.events) ? block.events : [];
        const digest = typeof block.digest === "string" ? block.digest : null;
        const timestampMs = readTxTimestampMs(block);
        const hasDusdcPayout = hasPositiveWalletDusdcBalanceChange(
            block.balanceChanges,
            walletAddress,
        );

        for (const event of events) {
            if (!isRecord(event)) continue;
            const eventType = typeof event.type === "string" ? event.type : null;
            // Augment with TX-level digest and timestampMs for readEventDigest/readEventTimestampMs fallbacks
            const augmented = { ...event, digest, timestampMs };

            if (eventType === POSITION_MINTED_EVENT_TYPE) {
                try {
                    const e = readPositionMintedEvent(augmented);
                    if (
                        e.trader.toLowerCase() === walletAddress.toLowerCase() &&
                        e.predictId === PREDICT_BINARY_CONFIG.predictObjectId &&
                        normalizeTypeName(e.quoteAssetName) ===
                            normalizeTypeName(PREDICT_BINARY_CONFIG.quoteCoinType) &&
                        e.cost > 0n &&
                        e.quantity > 0n
                    ) {
                        minted.push(e);
                    }
                } catch {
                    // skip malformed event
                }
            } else if (eventType === RANGE_MINTED_EVENT_TYPE) {
                try {
                    const e = readRangeMintedEvent([augmented]);
                    if (
                        e.trader.toLowerCase() === walletAddress.toLowerCase() &&
                        e.predictId === PREDICT_BINARY_CONFIG.predictObjectId &&
                        normalizeTypeName(e.quoteAssetName) ===
                            normalizeTypeName(PREDICT_BINARY_CONFIG.quoteCoinType) &&
                        e.cost > 0n &&
                        e.quantity > 0n
                    ) {
                        rangeMinted.push(e);
                    }
                } catch {
                    // skip malformed event
                }
            } else if (eventType === POSITION_REDEEMED_EVENT_TYPE) {
                try {
                    const e = readPositionRedeemedEvent(augmented);
                    redeemed.push(e);
                    // Claim: user's own TX redeemed a position and received DUSDC payout
                    if (hasDusdcPayout) {
                        claimedKeys.push(
                            [
                                e.oracleId,
                                e.expiryMs.toString(),
                                e.strike.toString(),
                                e.isUp ? "UP" : "DOWN",
                            ].join(":"),
                        );
                    }
                } catch {
                    // skip malformed event
                }
            }
        }
    }

    return { minted, rangeMinted, redeemed, claimedKeys };
}

async function buildPortfolioData(walletAddress: string): Promise<PortfolioData> {
    const { blocks, pagesRead, reachedLimit } = await fetchTxBlocks(walletAddress);
    const { minted, rangeMinted, redeemed, claimedKeys } = parseTxBlocksToPortfolio(
        blocks,
        walletAddress,
    );

    const managerIds = [...new Set(minted.map((e) => e.managerId))];
    const managerBalanceEntries = await mapWithConcurrency(
        managerIds,
        MANAGER_BALANCE_CONCURRENCY,
        async (managerId) => {
            try {
                const balance = await readManagerBalance(suiClient, walletAddress, managerId);
                return [managerId, balance.toString()] as const;
            } catch {
                return null;
            }
        },
    );
    const managerBalances = Object.fromEntries(
        managerBalanceEntries.filter((e): e is [string, string] => e !== null),
    );

    return {
        minted,
        rangeMinted,
        redeemed,
        claimedKeys,
        managerBalances,
        pagesInfo: {
            mintedPagesRead: pagesRead,
            mintedReachedLimit: reachedLimit,
            rangePagesRead: pagesRead,
            rangeReachedLimit: reachedLimit,
            redeemedPagesRead: pagesRead,
            redeemedReachedLimit: reachedLimit,
        },
    };
}

// --- Request parsing ---

function parseBody(value: unknown): { walletAddress: string } {
    if (!isRecord(value)) throw new Error("Invalid request body");
    const { walletAddress } = value;
    if (typeof walletAddress !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(walletAddress)) {
        throw new Error("Invalid walletAddress");
    }
    return { walletAddress };
}

// --- Route handler ---

export async function handlePredictPortfolioPost(request: NextRequest): Promise<NextResponse> {
    const isFresh = request.nextUrl.searchParams.get("fresh") === "1";

    try {
        const { walletAddress } = parseBody(await request.json());

        if (!isFresh) {
            const cached = portfolioCache.get(walletAddress);
            if (cached) {
                return NextResponse.json(serializeBigInts(cached));
            }
        }

        const data = await buildPortfolioData(walletAddress);
        portfolioCache.set(walletAddress, data);
        return NextResponse.json(serializeBigInts(data));
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        const status = message.includes("Invalid walletAddress") ? 400 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
