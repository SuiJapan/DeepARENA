export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const body = (await request.json().catch(() => null)) as { oracleIds?: unknown } | null;
    const oracleIds = Array.isArray(body?.oracleIds) ? body.oracleIds : [];
    return Response.json({
        states: oracleIds
            .filter((oracleId): oracleId is string => typeof oracleId === "string")
            .map((oracleId) => ({
                oracleId,
                lifecycle: "unknown",
                settlementPriceRaw: null,
            })),
    });
}
