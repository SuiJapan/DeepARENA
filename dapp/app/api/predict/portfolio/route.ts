import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { NextResponse } from "next/server";
import {
    type MintedPositionEvent,
    POSITION_MINTED_EVENT_TYPE,
    POSITION_REDEEMED_EVENT_TYPE,
    RANGE_MINTED_EVENT_TYPE,
    type RangeMintEvent,
    type RedeemedPositionEvent,
    readPositionMintedEvent,
    readPositionRedeemedEvent,
    readRangeMintedEvent,
} from "@/src/lib/predict-binary/client";
import { PREDICT_BINARY_CONFIG } from "@/src/lib/predict-binary/config";
import {
    hasWalletDusdcPositiveBalanceChange,
    isCacheEntryFresh,
    positionKeyFromRedeemed,
    type SerializedMintedPositionEvent,
    type SerializedRangeMintEvent,
    type SerializedRedeemedPositionEvent,
    serializeMintedEvent,
    serializeRangeMintedEvent,
    serializeRedeemedEvent,
} from "@/src/lib/predict-binary/portfolio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PortfolioResponse {
    ok: true;
    minted: SerializedMintedPositionEvent[];
    rangeMinted: SerializedRangeMintEvent[];
    redeemed: SerializedRedeemedPositionEvent[];
    claimedKeys: string[];
    cacheHit: boolean;
    reachedPageLimit: boolean;
}

interface ErrorResponse {
    ok: false;
    error: string;
}

// Event-based queries: pages against only this wallet's Predict events, so 20 pages is safe
const MAX_EVENT_PAGES = 20;
// TX-based query: pages against all TXs from wallet. Used only for redeemed + balanceChanges.
const MAX_TX_PAGES = 8;
const PAGE_SIZE = 50;
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_SIZE = 200;

const portfolioCache = new Map<string, { expiresAt: number; response: PortfolioResponse }>();

const suiClient = new SuiJsonRpcClient({
    network: PREDICT_BINARY_CONFIG.network,
    url: PREDICT_BINARY_CONFIG.fullnodeJsonRpcUrl,
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidWalletAddress(address: unknown): address is string {
    return typeof address === "string" && address.length > 0;
}

function isEventType(event: unknown, type: string): boolean {
    if (!isRecord(event)) {
        return false;
    }
    return event.eventType === type || event.type === type;
}

function normalizeTypeName(value: string): string {
    return value.toLowerCase().replace(/^0x/, "");
}

function isMatchingMarket(event: { predictId: string; quoteAssetName: string }): boolean {
    return (
        event.predictId === PREDICT_BINARY_CONFIG.predictObjectId &&
        normalizeTypeName(event.quoteAssetName) ===
            normalizeTypeName(PREDICT_BINARY_CONFIG.quoteCoinType)
    );
}

async function queryEventsBySenderAndType(
    walletAddress: string,
    eventType: string,
    maxPages: number,
): Promise<{ events: unknown[]; reachedLimit: boolean }> {
    const events: unknown[] = [];
    let cursor: unknown = null;
    const filter = {
        All: [{ Sender: walletAddress }, { MoveEventType: eventType }],
    };
    for (let page = 0; page < maxPages; page += 1) {
        const response = await fetch(PREDICT_BINARY_CONFIG.fullnodeJsonRpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: page + 1,
                method: "suix_queryEvents",
                params: [filter, cursor, PAGE_SIZE, false],
            }),
        });
        if (!response.ok) {
            throw new Error(`Event query failed for ${eventType}: ${response.status}`);
        }
        const payload = (await response.json()) as unknown;
        if (
            !isRecord(payload) ||
            !isRecord(payload.result) ||
            !Array.isArray(payload.result.data)
        ) {
            throw new Error(`Invalid event query response for ${eventType}`);
        }
        events.push(...payload.result.data);
        if (payload.result.hasNextPage !== true) {
            return { events, reachedLimit: false };
        }
        if (page === maxPages - 1) {
            return { events, reachedLimit: true };
        }
        cursor = payload.result.nextCursor;
    }
    return { events, reachedLimit: false };
}

export async function POST(
    request: Request,
): Promise<NextResponse<PortfolioResponse | ErrorResponse>> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
    }

    if (!isRecord(body)) {
        return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
    }

    const { walletAddress } = body;
    if (!isValidWalletAddress(walletAddress)) {
        return NextResponse.json({ ok: false, error: "Invalid walletAddress" }, { status: 400 });
    }

    const fresh = body.fresh === true || body.fresh === "1" || body.fresh === "true";
    const cacheKey = walletAddress.toLowerCase();

    if (!fresh) {
        const cached = portfolioCache.get(cacheKey);
        if (cached !== undefined && isCacheEntryFresh(cached, Date.now())) {
            return NextResponse.json({ ...cached.response, cacheHit: true });
        }
    }

    try {
        const minted: MintedPositionEvent[] = [];
        const rangeMinted: RangeMintEvent[] = [];
        const redeemed: RedeemedPositionEvent[] = [];
        const claimedKeys: string[] = [];
        let reachedPageLimit = false;

        // Step 1: fetch minted events via event query.
        // Sender + MoveEventType filter means unrelated TXs don't consume page slots,
        // and older Predict events are not pushed out.
        const [mintedResult, rangeMintedResult] = await Promise.all([
            queryEventsBySenderAndType(walletAddress, POSITION_MINTED_EVENT_TYPE, MAX_EVENT_PAGES),
            queryEventsBySenderAndType(walletAddress, RANGE_MINTED_EVENT_TYPE, MAX_EVENT_PAGES),
        ]);

        if (mintedResult.reachedLimit || rangeMintedResult.reachedLimit) {
            reachedPageLimit = true;
        }

        for (const event of mintedResult.events) {
            try {
                const m = readPositionMintedEvent(event);
                if (!isMatchingMarket(m)) continue;
                minted.push(m);
            } catch {
                // skip malformed events
            }
        }

        for (const event of rangeMintedResult.events) {
            try {
                const r = readRangeMintedEvent([event]);
                if (!isMatchingMarket(r)) continue;
                rangeMinted.push(r);
            } catch {
                // skip malformed events
            }
        }

        // Step 2: fetch redeemed events + balanceChanges via TX query.
        // We need balanceChanges for Claimed detection, so TX query is required here.
        // Redeems are typically recent TXs so MAX_TX_PAGES is sufficient.
        let cursor: string | null | undefined;

        for (let page = 0; page < MAX_TX_PAGES; page += 1) {
            const result = await suiClient.queryTransactionBlocks({
                filter: { FromAddress: walletAddress },
                options: { showEvents: true, showBalanceChanges: true },
                order: "descending",
                limit: PAGE_SIZE,
                cursor: cursor ?? undefined,
            });

            for (const tx of result.data) {
                const events = isRecord(tx) && Array.isArray(tx.events) ? tx.events : [];

                for (const event of events) {
                    if (!isEventType(event, POSITION_REDEEMED_EVENT_TYPE)) {
                        continue;
                    }
                    let redeemedEvent: RedeemedPositionEvent | null = null;
                    try {
                        redeemedEvent = readPositionRedeemedEvent(event);
                        redeemed.push(redeemedEvent);
                    } catch {
                        // skip malformed events
                    }

                    if (
                        redeemedEvent !== null &&
                        hasWalletDusdcPositiveBalanceChange(
                            tx,
                            walletAddress,
                            PREDICT_BINARY_CONFIG.quoteCoinType,
                        )
                    ) {
                        const key = positionKeyFromRedeemed({
                            oracleId: redeemedEvent.oracleId,
                            expiryMs: redeemedEvent.expiryMs,
                            strike: redeemedEvent.strike,
                            isUp: redeemedEvent.isUp,
                        });
                        if (!claimedKeys.includes(key)) {
                            claimedKeys.push(key);
                        }
                    }
                }
            }

            if (!result.hasNextPage || result.nextCursor == null) {
                break;
            }
            if (page === MAX_TX_PAGES - 1) {
                reachedPageLimit = true;
                break;
            }
            cursor = result.nextCursor;
        }

        const response: PortfolioResponse = {
            ok: true,
            minted: minted.map(serializeMintedEvent),
            rangeMinted: rangeMinted.map(serializeRangeMintedEvent),
            redeemed: redeemed.map(serializeRedeemedEvent),
            claimedKeys,
            cacheHit: false,
            reachedPageLimit,
        };

        if (portfolioCache.size >= CACHE_MAX_SIZE) {
            const oldestKey = portfolioCache.keys().next().value;
            if (oldestKey !== undefined) {
                portfolioCache.delete(oldestKey);
            }
        }
        portfolioCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, response });

        return NextResponse.json(response);
    } catch (caught) {
        console.error("portfolio route error", caught);
        const message = caught instanceof Error ? caught.message : String(caught);
        return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
}
