export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const body = (await request.json().catch(() => null)) as {
        direction?: unknown;
        oracleId?: unknown;
    } | null;
    const direction = body?.direction === "BREAK" ? "BREAK" : "RANGE";
    const oracleId = typeof body?.oracleId === "string" ? body.oracleId : "unknown";
    return Response.json({
        ok: false,
        direction,
        previewKey: `temporary:${direction}:${oracleId}`,
        error: "Range preview is temporarily unavailable",
        reason: "TEMPORARY_LIGHTWEIGHT_ROUTE",
    });
}
