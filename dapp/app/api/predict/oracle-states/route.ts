import { NextResponse } from "next/server";
import { PREDICT_BINARY_CONFIG } from "@/src/lib/predict-binary/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface OracleStateResponse {
    oracleId: string;
    ok: boolean;
    lifecycle: string | null;
    settlementPriceRaw: string | null;
    error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readU64String(value: unknown): string | null {
    const text = typeof value === "number" ? String(value) : value;
    if (typeof text === "string" && /^(0|[1-9]\d*)$/.test(text)) {
        return text;
    }
    return null;
}

function readStringOrNull(value: unknown): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (Array.isArray(value)) {
        return value.length > 0 ? readU64String(value[0]) : null;
    }
    if (isRecord(value)) {
        if ("Some" in value) return readU64String(value.Some);
        if ("some" in value) return readU64String(value.some);
        if ("value" in value) return readU64String(value.value);
        if ("fields" in value) return readStringOrNull(value.fields);
        if ("vec" in value) return readStringOrNull(value.vec);
        if ("None" in value || "none" in value) return null;
    }
    return readU64String(value);
}

function readSettlementPriceRaw(value: Record<string, unknown>): string | null {
    for (const key of [
        "settlement_price",
        "settlementPrice",
        "settlementPriceRaw",
        "settlement_price_raw",
    ]) {
        if (value[key] === undefined || value[key] === null) {
            continue;
        }
        const raw = readStringOrNull(value[key]);
        if (raw !== null) {
            return raw;
        }
    }
    return null;
}

async function fetchOracleState(oracleId: string): Promise<OracleStateResponse> {
    try {
        const response = await fetch(
            `${PREDICT_BINARY_CONFIG.predictServerUrl}/oracles/${oracleId}/state`,
            { cache: "no-store" },
        );
        if (!response.ok) {
            return {
                oracleId,
                ok: false,
                lifecycle: null,
                settlementPriceRaw: null,
                error: `Unexpected status code: ${response.status}`,
            };
        }
        const payload = (await response.json()) as unknown;
        if (!isRecord(payload)) {
            return {
                oracleId,
                ok: false,
                lifecycle: null,
                settlementPriceRaw: null,
                error: "Invalid oracle state response",
            };
        }
        return {
            oracleId,
            ok: true,
            lifecycle: readStringOrNull(payload.lifecycle),
            settlementPriceRaw: readSettlementPriceRaw(payload),
            error: null,
        };
    } catch (caught) {
        return {
            oracleId,
            ok: false,
            lifecycle: null,
            settlementPriceRaw: null,
            error: caught instanceof Error ? caught.message : String(caught),
        };
    }
}

export async function POST(request: Request): Promise<NextResponse<{ states: OracleStateResponse[] }>> {
    const body = (await request.json()) as unknown;
    const oracleIds = isRecord(body) && Array.isArray(body.oracleIds) ? body.oracleIds : [];
    const uniqueOracleIds = [...new Set(oracleIds)]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .slice(0, 100);
    const states = await Promise.all(uniqueOracleIds.map(fetchOracleState));
    return NextResponse.json({ states });
}
