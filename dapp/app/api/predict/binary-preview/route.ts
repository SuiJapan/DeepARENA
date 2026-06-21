export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unavailableSide() {
    return {
        ok: false,
        error: "Binary preview is temporarily unavailable",
        debug: {
            reason: "TEMPORARY_LIGHTWEIGHT_ROUTE",
            devInspectError: null,
            moveAbortCode: null,
            moveTarget: null,
            transactionInputs: null,
            lastTriedQuantity: null,
            lastMintCost: null,
            lastRedeemPayout: null,
            returnValuesRaw: null,
            decodedMintCost: null,
            decodedRedeemPayout: null,
        },
    };
}

export async function POST(request: Request) {
    const body = (await request.json().catch(() => null)) as { oracleId?: unknown } | null;
    const oracleId = typeof body?.oracleId === "string" ? body.oracleId : "unknown";
    return Response.json({
        ok: true,
        previewKey: `temporary:${oracleId}`,
        cacheHit: false,
        up: unavailableSide(),
        down: unavailableSide(),
    });
}
