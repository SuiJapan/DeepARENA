export const BETTING_CLOSE_OFFSET_MS = 5 * 60 * 1000;
export const GRID_TICKS = 100_000n;

export type PredictRoundStatus =
    | "LOADING"
    | "NO_ACTIVE_ROUND"
    | "LOCKING_ROUND"
    | "BETTING_OPEN"
    | "FINAL_LIVE"
    | "PRICE_FEED_ERROR"
    | "AWAITING_SETTLEMENT"
    | "ROUND_LOCK_ERROR"
    | "ROUND_DATA_ERROR"
    | "ERROR";

export interface OracleCandidate {
    oracleId: string;
    underlyingAsset: string;
    lifecycle: string;
    expiryMs: number;
    activatedAtMs: number | null;
}

export interface CurrentOracleSelection {
    currentOracle: OracleCandidate | null;
    previousOracle: OracleCandidate | null;
    nextOracle: OracleCandidate | null;
}

export interface StrikeGrid {
    minStrike: bigint;
    tickSize: bigint;
}

export interface RoundStrikes {
    binaryStrike: bigint;
}

export interface SettlementRoundInput {
    currentOracleId: string;
    previousOracleId: string;
    previousExpiryMs: number;
    openingSpotRaw: string;
    grid: StrikeGrid;
}

export interface SettlementRoundLock {
    roundId: string;
    roundOpenMs: number;
    openingSpotRaw: string;
    binaryStrikeRaw: string;
}

export function selectCurrentBtcOracle(
    oracles: OracleCandidate[],
    nowMs: number,
): CurrentOracleSelection {
    const btcOracles = oracles
        .filter((oracle) => oracle.underlyingAsset === "BTC")
        .sort((left, right) => left.expiryMs - right.expiryMs);
    const boundaryOracle =
        [...btcOracles].reverse().find((oracle) => oracle.expiryMs <= nowMs) ?? null;
    const roundBoundaryMs = boundaryOracle?.expiryMs ?? null;
    const futureActive = btcOracles.filter((oracle) => {
        if (oracle.lifecycle !== "active") {
            return false;
        }
        if (roundBoundaryMs === null) {
            return oracle.expiryMs > nowMs;
        }
        if (oracle.expiryMs <= roundBoundaryMs) {
            return false;
        }
        return oracle.activatedAtMs === null || oracle.activatedAtMs <= roundBoundaryMs;
    });
    const currentOracle = futureActive[0] ?? null;
    const previousOracle = currentOracle
        ? ([...btcOracles].reverse().find((oracle) => oracle.expiryMs < currentOracle.expiryMs) ??
          null)
        : null;
    const nextOracle =
        currentOracle && futureActive.length > 1
            ? (futureActive.find((oracle) => oracle.expiryMs > currentOracle.expiryMs) ?? null)
            : null;

    return { currentOracle, previousOracle, nextOracle };
}

export function calculateRoundOpen({
    previousExpiryMs,
    activatedAtMs,
}: {
    previousExpiryMs: number | null;
    activatedAtMs: number | null;
}): number | null {
    return previousExpiryMs ?? activatedAtMs;
}

export function calculateBettingClose(expiryMs: number): number {
    return expiryMs - BETTING_CLOSE_OFFSET_MS;
}

export function calculateGridMaxStrike({ minStrike, tickSize }: StrikeGrid): bigint {
    return minStrike + tickSize * GRID_TICKS;
}

export function isGridStrike(strike: bigint, grid: StrikeGrid): boolean {
    if (grid.tickSize <= 0n || strike < grid.minStrike) {
        return false;
    }
    return (strike - grid.minStrike) % grid.tickSize === 0n;
}

export function selectNearestGridStrike(openingSpot: bigint, grid: StrikeGrid): bigint {
    const maxStrike = calculateGridMaxStrike(grid);
    const minCenterStrike = grid.minStrike + grid.tickSize;
    const maxCenterStrike = maxStrike - grid.tickSize;
    if (minCenterStrike > maxCenterStrike) {
        throw new Error("Oracle strike grid cannot produce range boundaries");
    }

    const rawIndex =
        openingSpot <= grid.minStrike ? 0n : (openingSpot - grid.minStrike) / grid.tickSize;
    const lower = grid.minStrike + rawIndex * grid.tickSize;
    const upper = lower + grid.tickSize;
    const lowerDistance = openingSpot > lower ? openingSpot - lower : lower - openingSpot;
    const upperDistance = openingSpot > upper ? openingSpot - upper : upper - openingSpot;
    const nearest = upperDistance < lowerDistance ? upper : lower;

    if (nearest < minCenterStrike) {
        return minCenterStrike;
    }
    if (nearest > maxCenterStrike) {
        return maxCenterStrike;
    }
    return nearest;
}

export function buildRoundStrikes(openingSpot: bigint, grid: StrikeGrid): RoundStrikes {
    const binaryStrike = selectNearestGridStrike(openingSpot, grid);
    if (!isGridStrike(binaryStrike, grid)) {
        throw new Error("Round strikes are not on the oracle grid");
    }
    return { binaryStrike };
}

export function buildSettlementRoundLock({
    currentOracleId,
    previousOracleId,
    previousExpiryMs,
    openingSpotRaw,
    grid,
}: SettlementRoundInput): SettlementRoundLock {
    const strikes = buildRoundStrikes(BigInt(openingSpotRaw), grid);
    return {
        roundId: `${currentOracleId}:${previousOracleId}:${previousExpiryMs}`,
        roundOpenMs: previousExpiryMs,
        openingSpotRaw,
        binaryStrikeRaw: strikes.binaryStrike.toString(),
    };
}

export function getRoundStatus({
    nowMs,
    bettingCloseMs,
    expiryMs,
    hasOpeningSpot,
    oracleLifecycle,
}: {
    nowMs: number;
    bettingCloseMs: number;
    expiryMs: number;
    hasOpeningSpot: boolean;
    oracleLifecycle: string;
}): PredictRoundStatus {
    if (oracleLifecycle !== "active") {
        return "NO_ACTIVE_ROUND";
    }
    if (nowMs >= expiryMs) {
        return "AWAITING_SETTLEMENT";
    }
    if (!hasOpeningSpot) {
        return "LOCKING_ROUND";
    }
    if (nowMs < bettingCloseMs) {
        return "BETTING_OPEN";
    }
    return "FINAL_LIVE";
}

export function formatRoundCountdownClock(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
        seconds,
    ).padStart(2, "0")}`;
}
