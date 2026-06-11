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
}

interface ErrorResponse {
    ok: false;
    error: string;
}

const MAX_PAGES = 4;
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

function hasDusdcPositiveBalanceChange(tx: unknown): boolean {
    if (!isRecord(tx)) {
        return false;
    }
    const balanceChanges = tx.balanceChanges;
    if (!Array.isArray(balanceChanges)) {
        return false;
    }
    const dusdcCoinType = PREDICT_BINARY_CONFIG.quoteCoinType.toLowerCase();
    for (const change of balanceChanges) {
        if (!isRecord(change)) {
            continue;
        }
        const coinType = typeof change.coinType === "string" ? change.coinType.toLowerCase() : "";
        if (coinType !== dusdcCoinType) {
            continue;
        }
        const amount =
            typeof change.amount === "string"
                ? change.amount
                : typeof change.amount === "number"
                  ? String(change.amount)
                  : null;
        if (amount === null) {
            continue;
        }
        // Positive amount means coins were received (claimed payout)
        const parsed = BigInt(amount);
        if (parsed > 0n) {
            return true;
        }
    }
    return false;
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

        let cursor: string | null | undefined;

        for (let page = 0; page < MAX_PAGES; page += 1) {
            const result = await suiClient.core.queryTransactionBlocks({
                filter: { FromAddress: walletAddress },
                options: { showEvents: true, showBalanceChanges: true },
                order: "descending",
                limit: PAGE_SIZE,
                cursor: cursor ?? undefined,
            });

            for (const tx of result.data) {
                const events = isRecord(tx) && Array.isArray(tx.events) ? tx.events : [];

                for (const event of events) {
                    if (isEventType(event, POSITION_MINTED_EVENT_TYPE)) {
                        try {
                            minted.push(readPositionMintedEvent(event));
                        } catch {
                            // skip malformed events
                        }
                    } else if (isEventType(event, RANGE_MINTED_EVENT_TYPE)) {
                        try {
                            rangeMinted.push(readRangeMintedEvent([event]));
                        } catch {
                            // skip malformed events
                        }
                    } else if (isEventType(event, POSITION_REDEEMED_EVENT_TYPE)) {
                        let redeemedEvent: RedeemedPositionEvent | null = null;
                        try {
                            redeemedEvent = readPositionRedeemedEvent(event);
                            redeemed.push(redeemedEvent);
                        } catch {
                            // skip malformed events
                        }

                        if (redeemedEvent !== null && hasDusdcPositiveBalanceChange(tx)) {
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
            }

            if (!result.hasNextPage || result.nextCursor == null) {
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
