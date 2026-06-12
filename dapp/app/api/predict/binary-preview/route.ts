import { NextResponse } from "next/server";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { PREDICT_BINARY_CONFIG } from "@/src/lib/predict-binary/config";
import {
    previewBinarySidesWithinBudgetFast,
    previewTradeWithinBudgetFast,
    TradePreviewError,
    type BudgetedTradePreview,
} from "@/src/lib/predict-binary/client";
import { formatBinaryOddsFromQuantity } from "@/src/lib/predict-binary/odds";
import { buildBinaryPreviewCacheKey } from "@/src/lib/predict-binary/preview-key";
import { getSharedPreviewCache } from "@/src/lib/server/preview-cache";

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
    cachePolicy: PreviewCachePolicy;
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
type PreviewCachePolicy = "read-through" | "bypass";

interface PreviewResponse {
    ok: true;
    previewKey: string;
    cacheHit: boolean;
    up: SideResponse;
    down: SideResponse;
}

const binaryPreviewCache = getSharedPreviewCache<PreviewResponse>("predict:binary-preview");

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

function readCachePolicy(value: unknown): PreviewCachePolicy {
    if (value === undefined || value === "read-through") {
        return "read-through";
    }
    if (value === "bypass") {
        return "bypass";
    }
    throw new Error("Invalid cachePolicy");
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
        cachePolicy: readCachePolicy(value.cachePolicy),
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
    return buildBinaryPreviewCacheKey({
        oracleId: body.oracleId,
        expiryMs: body.expiryMs,
        referenceStrikeRaw: body.referenceStrikeRaw,
        betAmountAtomic: body.betAmountAtomic,
    });
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

async function buildPreviewResponse(body: PreviewRequest, previewKey: string): Promise<PreviewResponse> {
    try {
        const { up, down } = await previewBinarySidesWithinBudgetFast({
            client: suiClient,
            sender: body.walletAddress,
            oracleId: body.oracleId,
            expiryMs: Number(body.expiryMs),
            strike: BigInt(body.referenceStrikeRaw),
            budget: BigInt(body.betAmountAtomic),
        });
        return {
            ok: true,
            previewKey,
            cacheHit: false,
            up: successResponse(up),
            down: successResponse(down),
        };
    } catch {
        const [up, down] = await Promise.all([previewSide(body, "UP"), previewSide(body, "DOWN")]);
        return { ok: true, previewKey, cacheHit: false, up, down };
    }
}

function hasSuccessfulSide(response: PreviewResponse): boolean {
    return response.up.ok || response.down.ok;
}

export function warmBinaryPreviewCache(input: {
    walletAddress: string;
    betAmountAtomic: string;
    oracleId: string;
    expiryMs: string;
    referenceStrikeRaw: string;
    oracleTimestampMs: string;
    predictObjectId: string;
    quoteCoinType: string;
}): void {
    const body = { ...input, cachePolicy: "read-through" as const };
    const previewKey = buildPreviewKey(body);
    binaryPreviewCache.warm(previewKey, () => buildPreviewResponse(body, previewKey), {
        shouldCache: hasSuccessfulSide,
    });
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
        const response =
            body.cachePolicy === "read-through"
                ? await binaryPreviewCache.getOrLoad(
                      previewKey,
                      () => buildPreviewResponse(body, previewKey),
                      { shouldCache: hasSuccessfulSide },
                  )
                : {
                      value: await buildPreviewResponse(body, previewKey),
                      state: "miss" as const,
                  };
        const jsonResponse = {
            ...response.value,
            cacheHit: response.state === "fresh" || response.state === "stale",
        };
        if (response.state === "fresh" || response.state === "stale") {
            return NextResponse.json(jsonResponse);
        }
        console.info("Binary preview API response", {
            previewKey,
            upOk: jsonResponse.up.ok,
            downOk: jsonResponse.down.ok,
            upQuantity: jsonResponse.up.ok ? jsonResponse.up.quantity : null,
            downQuantity: jsonResponse.down.ok ? jsonResponse.down.quantity : null,
            cacheState: response.state,
        });
        return NextResponse.json(jsonResponse);
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
