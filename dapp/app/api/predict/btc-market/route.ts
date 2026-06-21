export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
    const now = Date.now();
    const roundOpenMs = now - 60_000;
    const bettingCloseMs = now + 15 * 60_000;
    const expiryMs = now + 30 * 60_000;
    const oracleId = `temporary-${Math.floor(now / 60_000)}`;
    return Response.json({
        state: "BETTING_OPEN",
        currentOracle: {
            oracleId,
            expiryMs,
            lifecycle: "temporary",
            spotRaw: "65000000000000",
            forwardRaw: "65000000000000",
            timestampMs: now,
            minStrikeRaw: "1000000000",
            tickSizeRaw: "1000000000",
        },
        previousOracle: null,
        nextOracle: null,
        round: {
            roundId: oracleId,
            currentOracleId: oracleId,
            previousOracleId: "",
            roundOpenMs,
            bettingCloseMs,
            expiryMs,
            openingSpotRaw: "65000000000000",
            binaryStrikeRaw: "65000000000000",
            minStrikeRaw: "1000000000",
            tickSizeRaw: "1000000000",
            state: "BETTING_OPEN",
        },
        message: "Using temporary lightweight market data",
    });
}
