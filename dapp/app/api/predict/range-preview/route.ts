import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { NextResponse } from "next/server";
import {
    previewTradeWithinBudgetFast,
    previewRangeWithinBudgetFast,
    type RangeTradePreview,
    type BudgetedTradePreview,
} from "@/src/lib/predict-binary/client";
import { PREDICT_BINARY_CONFIG } from "@/src/lib/predict-binary/config";
import { formatBinaryOddsFromQuantity } from "@/src/lib/predict-binary/odds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RangePreviewRequest {
    direction: "RANGE" | "BREAK";
    walletAddress: string;
    betAmountAtomic: string;
    oracleId: string;
    expiryMs: string;
    referenceStrikeRaw: string;
    lowerStrikeRaw: string;
    higherStrikeRaw: string;
    widthTicks: string;
    oracleTimestampMs: string;
    predictObjectId: string;
    quoteCoinType: string;
}

interface RangePreviewSuccess {
    ok: true;
    direction: "RANGE";
    previewKey: string;
    quantity: string;
    mintCost: string;
    redeemPayout: string;
    liveOdds: string;
}

interface BreakLegPreviewResponse {
    quantity: string;
    mintCost: string;
    payout: string;
    liveOdds: string;
}

interface BreakPreviewSuccess {
    ok: true;
    direction: "BREAK";
    previewKey: string;
    mintCost: string;
    effectivePayout: string;
    liveOdds: string;
    lowerLeg: BreakLegPreviewResponse;
    upperLeg: BreakLegPreviewResponse;
}

interface RangePreviewFailure {
    ok: false;
    direction: "RANGE" | "BREAK";
    previewKey: string;
    error: string;
    reason: string;
}

type RangePreviewResponse = RangePreviewSuccess | BreakPreviewSuccess | RangePreviewFailure;

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

function parseBody(value: unknown): RangePreviewRequest {
    if (!isRecord(value)) {
        throw new Error("Invalid request body");
    }
    const request = {
        direction: readDirection(value.direction),
        walletAddress: readString(value.walletAddress, "walletAddress"),
        betAmountAtomic: readU64String(value.betAmountAtomic, "betAmountAtomic"),
        oracleId: readString(value.oracleId, "oracleId"),
        expiryMs: readU64String(value.expiryMs, "expiryMs"),
        referenceStrikeRaw: readU64String(value.referenceStrikeRaw, "referenceStrikeRaw"),
        lowerStrikeRaw: readU64String(value.lowerStrikeRaw, "lowerStrikeRaw"),
        higherStrikeRaw: readU64String(value.higherStrikeRaw, "higherStrikeRaw"),
        widthTicks: readU64String(value.widthTicks, "widthTicks"),
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

function readDirection(value: unknown): "RANGE" | "BREAK" {
    if (value === "RANGE" || value === "BREAK") {
        return value;
    }
    throw new Error("Invalid direction");
}

function buildPreviewKey(body: RangePreviewRequest): string {
    return [
        body.direction,
        body.walletAddress,
        body.oracleId,
        body.expiryMs,
        body.referenceStrikeRaw,
        body.lowerStrikeRaw,
        body.higherStrikeRaw,
        body.widthTicks,
        body.betAmountAtomic,
    ].join(":");
}

function successResponse(previewKey: string, preview: RangeTradePreview): RangePreviewSuccess {
    return {
        ok: true,
        direction: "RANGE",
        previewKey,
        quantity: preview.quantity.toString(),
        mintCost: preview.mintCost.toString(),
        redeemPayout: preview.redeemPayout.toString(),
        liveOdds: formatBinaryOddsFromQuantity(preview.quantity, preview.mintCost),
    };
}

function breakLegResponse(preview: BudgetedTradePreview): BreakLegPreviewResponse {
    return {
        quantity: preview.quantity.toString(),
        mintCost: preview.mintCost.toString(),
        payout: preview.quantity.toString(),
        liveOdds: formatBinaryOddsFromQuantity(preview.quantity, preview.mintCost),
    };
}

function breakSuccessResponse({
    previewKey,
    lowerLeg,
    upperLeg,
}: {
    previewKey: string;
    lowerLeg: BudgetedTradePreview;
    upperLeg: BudgetedTradePreview;
}): BreakPreviewSuccess {
    const mintCost = lowerLeg.mintCost + upperLeg.mintCost;
    const effectivePayout =
        lowerLeg.quantity < upperLeg.quantity ? lowerLeg.quantity : upperLeg.quantity;
    return {
        ok: true,
        direction: "BREAK",
        previewKey,
        mintCost: mintCost.toString(),
        effectivePayout: effectivePayout.toString(),
        liveOdds: formatBinaryOddsFromQuantity(effectivePayout, mintCost),
        lowerLeg: breakLegResponse(lowerLeg),
        upperLeg: breakLegResponse(upperLeg),
    };
}

function failureResponse(
    direction: "RANGE" | "BREAK",
    previewKey: string,
    error: string,
    reason: string,
): RangePreviewFailure {
    return {
        ok: false,
        direction,
        previewKey,
        error,
        reason,
    };
}

export async function POST(request: Request): Promise<NextResponse<RangePreviewResponse>> {
    let previewKey = "invalid";
    let direction: "RANGE" | "BREAK" = "RANGE";
    try {
        const body = parseBody(await request.json());
        direction = body.direction;
        previewKey = buildPreviewKey(body);
        const budget = BigInt(body.betAmountAtomic);
        if (budget <= 0n) {
            return NextResponse.json(
                failureResponse(direction, previewKey, "Preview failed", "BET_AMOUNT_NOT_POSITIVE"),
            );
        }
        if (BigInt(body.lowerStrikeRaw) >= BigInt(body.higherStrikeRaw)) {
            return NextResponse.json(
                failureResponse(direction, previewKey, "Preview failed", "INVALID_RANGE"),
            );
        }
        if (body.direction === "BREAK") {
            const lowerBudget = budget / 2n;
            const upperBudget = budget - lowerBudget;
            if (lowerBudget <= 0n || upperBudget <= 0n) {
                return NextResponse.json(
                    failureResponse(direction, previewKey, "Preview failed", "BET_AMOUNT_TOO_SMALL"),
                );
            }
            const [lowerLeg, upperLeg] = await Promise.all([
                previewTradeWithinBudgetFast({
                    client: suiClient,
                    sender: body.walletAddress,
                    oracleId: body.oracleId,
                    expiryMs: Number(body.expiryMs),
                    strike: BigInt(body.lowerStrikeRaw),
                    isUp: false,
                    budget: lowerBudget,
                }),
                previewTradeWithinBudgetFast({
                    client: suiClient,
                    sender: body.walletAddress,
                    oracleId: body.oracleId,
                    expiryMs: Number(body.expiryMs),
                    strike: BigInt(body.higherStrikeRaw),
                    isUp: true,
                    budget: upperBudget,
                }),
            ]);
            if (process.env.NODE_ENV !== "production") {
                const totalCost = lowerLeg.mintCost + upperLeg.mintCost;
                const effectivePayout =
                    lowerLeg.quantity < upperLeg.quantity ? lowerLeg.quantity : upperLeg.quantity;
                console.info("Range preview raw", {
                    direction: "BREAK",
                    previewKey,
                    oracleId: body.oracleId,
                    expiryMs: body.expiryMs,
                    lowerStrikeRaw: body.lowerStrikeRaw,
                    higherStrikeRaw: body.higherStrikeRaw,
                    betAmountAtomic: body.betAmountAtomic,
                    split: {
                        lowerBudget: lowerBudget.toString(),
                        upperBudget: upperBudget.toString(),
                    },
                    lowerLeg: {
                        side: "DOWN",
                        strikeRaw: body.lowerStrikeRaw,
                        quantity: lowerLeg.quantity.toString(),
                        mintCost: lowerLeg.mintCost.toString(),
                        payout: lowerLeg.quantity.toString(),
                        liveOdds: formatBinaryOddsFromQuantity(
                            lowerLeg.quantity,
                            lowerLeg.mintCost,
                        ),
                    },
                    upperLeg: {
                        side: "UP",
                        strikeRaw: body.higherStrikeRaw,
                        quantity: upperLeg.quantity.toString(),
                        mintCost: upperLeg.mintCost.toString(),
                        payout: upperLeg.quantity.toString(),
                        liveOdds: formatBinaryOddsFromQuantity(
                            upperLeg.quantity,
                            upperLeg.mintCost,
                        ),
                    },
                    effectivePayout: effectivePayout.toString(),
                    mintCost: totalCost.toString(),
                    effectiveOdds: formatBinaryOddsFromQuantity(effectivePayout, totalCost),
                });
            }
            return NextResponse.json(breakSuccessResponse({ previewKey, lowerLeg, upperLeg }));
        }
        const preview = await previewRangeWithinBudgetFast({
            client: suiClient,
            sender: body.walletAddress,
            oracleId: body.oracleId,
            expiryMs: Number(body.expiryMs),
            lowerStrike: BigInt(body.lowerStrikeRaw),
            higherStrike: BigInt(body.higherStrikeRaw),
            budget,
        });
        if (process.env.NODE_ENV !== "production") {
            console.info("Range preview raw", {
                direction: "RANGE",
                previewKey,
                oracleId: body.oracleId,
                expiryMs: body.expiryMs,
                lowerStrikeRaw: body.lowerStrikeRaw,
                higherStrikeRaw: body.higherStrikeRaw,
                betAmountAtomic: body.betAmountAtomic,
                quantity: preview.quantity.toString(),
                mintCost: preview.mintCost.toString(),
                redeemPayout: preview.redeemPayout.toString(),
                liveOdds: formatBinaryOddsFromQuantity(preview.quantity, preview.mintCost),
            });
        }
        return NextResponse.json(successResponse(previewKey, preview));
    } catch (caught) {
        console.warn("range-preview route failed", {
            previewKey,
            reason: caught instanceof Error ? caught.message : String(caught),
        });
        return NextResponse.json(
            failureResponse(
                direction,
                previewKey,
                "Preview failed",
                caught instanceof Error ? caught.message : "SERVER_ERROR",
            ),
        );
    }
}
