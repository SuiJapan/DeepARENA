import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { NextResponse } from "next/server";
import {
    previewRangeTradeAmountsServerOnly,
} from "@/lib/predict-binary/client";
import { PREDICT_BINARY_CONFIG } from "@/lib/predict-binary/config";
import {
    RANGE_WIDTH_CANDIDATES_TICKS,
    rangeProbabilityBps,
    selectRangeWidthQuote,
    type RangeWidthQuote,
} from "@/lib/predict-range/range-width";
import { getSharedPreviewCache } from "@/lib/server/preview-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fixed probe quantity ensures consistent width selection across users
const PROBE_QUANTITY = 10_000_000n; // 10 DUSDC in atomic units

const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 10;
const ipCounts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = ipCounts.get(ip);
    if (!entry || now >= entry.resetAt) {
        ipCounts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return true;
    }
    if (entry.count >= RATE_LIMIT_MAX) return false;
    entry.count++;
    return true;
}

interface RangeWidthRequest {
    walletAddress: string;
    oracleId: string;
    expiryMs: string;
    referenceStrikeRaw: string;
    tickSizeRaw: string;
    predictObjectId: string;
    quoteCoinType: string;
}

interface RangeWidthData {
    selectedWidthTicks: string;
    lowerStrikeRaw: string;
    higherStrikeRaw: string;
    probabilityBps: string;
    inTargetBand: boolean;
}

interface RangeWidthSuccess extends RangeWidthData {
    ok: true;
    cacheHit: boolean;
}

interface RangeWidthFailure {
    ok: false;
    error: string;
}

type RangeWidthResponse = RangeWidthSuccess | RangeWidthFailure;

// Cache keyed by roundId only (no walletAddress) — ensures all users see the same selection
const widthSelectCache = getSharedPreviewCache<RangeWidthData>("predict:range-width-select");

const suiClient = new SuiJsonRpcClient({
    network: PREDICT_BINARY_CONFIG.network,
    url: PREDICT_BINARY_CONFIG.fullnodeJsonRpcUrl,
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return value;
}

function readU64String(value: unknown, fieldName: string): string {
    const text = readString(value, fieldName);
    if (!/^(0|[1-9]\d*)$/.test(text)) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return text;
}

function parseBody(value: unknown): RangeWidthRequest {
    if (!isRecord(value)) {
        throw new Error("Invalid request body");
    }
    const request = {
        walletAddress: readString(value.walletAddress, "walletAddress"),
        oracleId: readString(value.oracleId, "oracleId"),
        expiryMs: readU64String(value.expiryMs, "expiryMs"),
        referenceStrikeRaw: readU64String(value.referenceStrikeRaw, "referenceStrikeRaw"),
        tickSizeRaw: readU64String(value.tickSizeRaw, "tickSizeRaw"),
        predictObjectId: readString(value.predictObjectId, "predictObjectId"),
        quoteCoinType: readString(value.quoteCoinType, "quoteCoinType"),
    };
    if (request.predictObjectId !== PREDICT_BINARY_CONFIG.predictObjectId) {
        throw new Error("Invalid predictObjectId");
    }
    if (request.quoteCoinType !== PREDICT_BINARY_CONFIG.quoteCoinType) {
        throw new Error("Invalid quoteCoinType");
    }
    return request;
}

function buildCacheKey(body: RangeWidthRequest): string {
    return `${body.oracleId}:${body.expiryMs}:${body.referenceStrikeRaw}`;
}

async function probeCandidate(
    walletAddress: string,
    oracleId: string,
    expiryMs: number,
    referenceStrikeRaw: bigint,
    tickSizeRaw: bigint,
    widthTicks: bigint,
): Promise<RangeWidthQuote | null> {
    const lowerStrike = referenceStrikeRaw - tickSizeRaw * widthTicks;
    const higherStrike = referenceStrikeRaw + tickSizeRaw * widthTicks;
    if (lowerStrike <= 0n || lowerStrike >= higherStrike) {
        return null;
    }
    try {
        const amounts = await previewRangeTradeAmountsServerOnly(suiClient, {
            sender: walletAddress,
            oracleId,
            expiryMs,
            lowerStrike,
            higherStrike,
            quantity: PROBE_QUANTITY,
        });
        if (amounts.mintCost <= 0n) return null;
        return { widthTicks, quantity: PROBE_QUANTITY, mintCost: amounts.mintCost };
    } catch {
        return null;
    }
}

async function selectWidth(body: RangeWidthRequest): Promise<RangeWidthData> {
    const oracleId = body.oracleId;
    const expiryMs = Number(body.expiryMs);
    const referenceStrikeRaw = BigInt(body.referenceStrikeRaw);
    const tickSizeRaw = BigInt(body.tickSizeRaw);

    const probeResults = await Promise.allSettled(
        RANGE_WIDTH_CANDIDATES_TICKS.map((widthTicks) =>
            probeCandidate(
                body.walletAddress,
                oracleId,
                expiryMs,
                referenceStrikeRaw,
                tickSizeRaw,
                widthTicks,
            ),
        ),
    );

    const quotes: RangeWidthQuote[] = probeResults.flatMap((result) =>
        result.status === "fulfilled" && result.value !== null ? [result.value] : [],
    );

    const selection = selectRangeWidthQuote(quotes);
    if (!selection) {
        throw new Error("No viable range width found for current oracle");
    }

    const selectedQuote = quotes.find((q) => q.widthTicks === selection.widthTicks);
    const probBps = selectedQuote
        ? rangeProbabilityBps(selectedQuote)
        : selection.probabilityBps;

    const lowerStrikeRaw = referenceStrikeRaw - tickSizeRaw * selection.widthTicks;
    const higherStrikeRaw = referenceStrikeRaw + tickSizeRaw * selection.widthTicks;

    return {
        selectedWidthTicks: selection.widthTicks.toString(),
        lowerStrikeRaw: lowerStrikeRaw.toString(),
        higherStrikeRaw: higherStrikeRaw.toString(),
        probabilityBps: probBps.toString(),
        inTargetBand: selection.inTargetBand,
    };
}

export async function POST(request: Request): Promise<NextResponse<RangeWidthResponse>> {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    if (!checkRateLimit(ip)) {
        return NextResponse.json(
            { ok: false, error: "Too many requests" },
            { status: 429 },
        );
    }
    try {
        const body = parseBody(await request.json());
        const cacheKey = buildCacheKey(body);
        const cached = await widthSelectCache.getOrLoad(cacheKey, () => selectWidth(body));
        return NextResponse.json({
            ...cached.value,
            ok: true,
            cacheHit: cached.state !== "miss",
        });
    } catch (caught) {
        console.warn("range-width route failed", {
            reason: caught instanceof Error ? caught.message : String(caught),
        });
        return NextResponse.json(
            {
                ok: false,
                error: caught instanceof Error ? caught.message : "Range width selection failed",
            },
            { status: 500 },
        );
    }
}
