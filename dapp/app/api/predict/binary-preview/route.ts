import { NextResponse } from "next/server";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { PREDICT_BINARY_CONFIG } from "@/src/lib/predict-binary/config";
import {
    previewTradeWithinBudgetFast,
    TradePreviewError,
    type BudgetedTradePreview,
} from "@/src/lib/predict-binary/client";
import { formatBinaryOddsFromQuantity } from "@/src/lib/predict-binary/odds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PreviewSide = "UP" | "DOWN";

interface PreviewRequest {
    walletAddress: string;
    betAmountAtomic: string;
    oracleId: string;
    expiryMs: string;
    referenceStrikeRaw: string;
    oracleTimestampMs: string;
    predictObjectId: string;
    quoteCoinType: string;
}

interface SideSuccessResponse {
    ok: true;
    quantity: string;
    mintCost: string;
    redeemPayout: string;
    liveOdds: string;
    debug: SideDebug;
}

interface SideFailureResponse {
    ok: false;
    error: string;
    debug: SideDebug;
}

interface SideDebug {
    reason: string;
    devInspectError: string | null;
    moveAbortCode: string | null;
    moveTarget: string | null;
    transactionInputs: unknown;
    lastTriedQuantity: string | null;
    lastMintCost: string | null;
    lastRedeemPayout: string | null;
    returnValuesRaw: unknown;
    decodedMintCost: string | null;
    decodedRedeemPayout: string | null;
}

type SideResponse = SideSuccessResponse | SideFailureResponse;

interface PreviewResponse {
    ok: true;
    previewKey: string;
    cacheHit: boolean;
    up: SideResponse;
    down: SideResponse;
}

const CACHE_TTL_MS = 4_000;
const previewCache = new Map<string, { expiresAt: number; response: PreviewResponse }>();

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

function parseBody(value: unknown): PreviewRequest {
    if (!isRecord(value)) {
        throw new Error("Invalid request body");
    }
    const request = {
        walletAddress: readString(value.walletAddress, "walletAddress"),
        betAmountAtomic: readU64String(value.betAmountAtomic, "betAmountAtomic"),
        oracleId: readString(value.oracleId, "oracleId"),
        expiryMs: readU64String(value.expiryMs, "expiryMs"),
        referenceStrikeRaw: readU64String(value.referenceStrikeRaw, "referenceStrikeRaw"),
        oracleTimestampMs: readU64String(value.oracleTimestampMs, "oracleTimestampMs"),
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

function readDebugString(debug: unknown, fieldName: string): string | null {
    if (!isRecord(debug)) {
        return null;
    }
    const value = debug[fieldName];
    return typeof value === "string" ? value : null;
}

function readDebugValue(debug: unknown, fieldName: string): unknown {
    return isRecord(debug) ? debug[fieldName] : null;
}

function debugFromPreview(preview: BudgetedTradePreview, reason: string): SideDebug {
    return {
        reason,
        devInspectError: readDebugString(preview.debug, "devInspectError"),
        moveAbortCode: readDebugString(preview.debug, "moveAbortCode"),
        moveTarget: readDebugString(preview.debug, "moveTarget"),
        transactionInputs: readDebugValue(preview.debug, "transactionInputs"),
        lastTriedQuantity: preview.quantity.toString(),
        lastMintCost: preview.mintCost.toString(),
        lastRedeemPayout: preview.redeemPayout.toString(),
        returnValuesRaw: readDebugValue(preview.debug, "returnValuesRaw"),
        decodedMintCost: readDebugString(preview.debug, "decodedMintCost") ?? preview.mintCost.toString(),
        decodedRedeemPayout:
            readDebugString(preview.debug, "decodedRedeemPayout") ?? preview.redeemPayout.toString(),
    };
}

function successResponse(preview: BudgetedTradePreview): SideSuccessResponse {
    return {
        ok: true,
        quantity: preview.quantity.toString(),
        mintCost: preview.mintCost.toString(),
        redeemPayout: preview.redeemPayout.toString(),
        liveOdds: formatBinaryOddsFromQuantity(preview.quantity, preview.mintCost).replace(/x$/, ""),
        debug: debugFromPreview(preview, "OK"),
    };
}

function failureResponse(error: string, reason: string, caught?: unknown): SideFailureResponse {
    const details = caught instanceof TradePreviewError ? caught.details : null;
    return {
        ok: false,
        error,
        debug: {
            reason,
            devInspectError: details?.devInspectError ?? (caught instanceof Error ? caught.message : null),
            moveAbortCode: details?.moveAbortCode ?? null,
            moveTarget: details?.moveTarget ?? null,
            transactionInputs: details?.transactionInputs ?? null,
            lastTriedQuantity: details?.quantityCandidate ?? null,
            lastMintCost: details?.decodedMintCost ?? null,
            lastRedeemPayout: details?.decodedRedeemPayout ?? null,
            returnValuesRaw: details?.returnValuesRaw ?? null,
            decodedMintCost: details?.decodedMintCost ?? null,
            decodedRedeemPayout: details?.decodedRedeemPayout ?? null,
        },
    };
}

function buildPreviewKey(body: PreviewRequest): string {
    return [
        body.oracleId,
        body.expiryMs,
        body.referenceStrikeRaw,
        body.oracleTimestampMs,
        body.betAmountAtomic,
    ].join(":");
}

async function previewSide(body: PreviewRequest, side: PreviewSide): Promise<SideResponse> {
    try {
        const preview = await previewTradeWithinBudgetFast({
            client: suiClient,
            sender: body.walletAddress,
            oracleId: body.oracleId,
            expiryMs: Number(body.expiryMs),
            strike: BigInt(body.referenceStrikeRaw),
            isUp: side === "UP",
            budget: BigInt(body.betAmountAtomic),
        });
        return successResponse(preview);
    } catch (caught) {
        if (caught instanceof TradePreviewError) {
            return failureResponse("Preview failed", "TRADE_PREVIEW_FAILED", caught);
        }
        return failureResponse(
            "Preview failed",
            "SERVER_ERROR",
            caught instanceof Error ? caught : new Error(String(caught)),
        );
    }
}

export async function POST(request: Request): Promise<NextResponse<PreviewResponse>> {
    try {
        const body = parseBody(await request.json());
        if (BigInt(body.betAmountAtomic) <= 0n) {
            const previewKey = buildPreviewKey(body);
            return NextResponse.json({
                ok: true,
                previewKey,
                cacheHit: false,
                up: failureResponse("Preview failed", "BET_AMOUNT_NOT_POSITIVE"),
                down: failureResponse("Preview failed", "BET_AMOUNT_NOT_POSITIVE"),
            });
        }

        const previewKey = buildPreviewKey(body);
        const cached = previewCache.get(previewKey);
        if (cached && cached.expiresAt > Date.now()) {
            return NextResponse.json({ ...cached.response, cacheHit: true });
        }

        const [up, down] = await Promise.all([previewSide(body, "UP"), previewSide(body, "DOWN")]);
        const response = { ok: true as const, previewKey, cacheHit: false, up, down };
        if (up.ok || down.ok) {
            previewCache.set(previewKey, { expiresAt: Date.now() + CACHE_TTL_MS, response });
        }
        console.info("Binary preview API response", {
            previewKey,
            upOk: up.ok,
            downOk: down.ok,
            upQuantity: up.ok ? up.quantity : null,
            downQuantity: down.ok ? down.quantity : null,
            cacheTtlMs: CACHE_TTL_MS,
        });
        return NextResponse.json(response);
    } catch (caught) {
        console.error("binary-preview route fatal error", caught);
        const previewKey = "invalid";
        return NextResponse.json(
            {
                ok: true,
                previewKey,
                cacheHit: false,
                up: failureResponse(
                    "Preview failed",
                    "SERVER_ERROR",
                    caught instanceof Error ? caught : new Error(String(caught)),
                ),
                down: failureResponse(
                    "Preview failed",
                    "SERVER_ERROR",
                    caught instanceof Error ? caught : new Error(String(caught)),
                ),
            },
            { status: 500 },
        );
    }
}
