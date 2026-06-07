"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatRoundCountdownClock, type PredictRoundStatus } from "@/src/lib/predict-round/round";

export interface PredictOracleSummary {
    oracleId: string;
    expiryMs: number;
}

export interface PredictPreviousOracle extends PredictOracleSummary {
    lifecycle: string;
    settlementPriceRaw: string | null;
}

export interface PredictCurrentOracle extends PredictOracleSummary {
    lifecycle: string;
    spotRaw: string | null;
    forwardRaw: string | null;
    timestampMs: number | null;
    minStrikeRaw: string | null;
    tickSizeRaw: string | null;
}

export interface PredictRoundDetails {
    roundId: string;
    currentOracleId: string;
    previousOracleId: string;
    roundOpenMs: number;
    bettingCloseMs: number;
    expiryMs: number;
    openingSpotRaw: string;
    binaryStrikeRaw: string;
    minStrikeRaw: string;
    tickSizeRaw: string;
    state: PredictRoundStatus;
}

export interface PredictRoundMarket {
    state: PredictRoundStatus;
    currentOracle: PredictCurrentOracle | null;
    previousOracle: PredictPreviousOracle | null;
    nextOracle: PredictOracleSummary | null;
    round: PredictRoundDetails | null;
    message?: string;
    debug?: Record<string, unknown>;
}

function hasRoundLockChanged(previous: PredictRoundDetails, next: PredictRoundDetails): boolean {
    return (
        previous.currentOracleId !== next.currentOracleId ||
        previous.previousOracleId !== next.previousOracleId ||
        previous.expiryMs !== next.expiryMs ||
        previous.roundOpenMs !== next.roundOpenMs ||
        previous.openingSpotRaw !== next.openingSpotRaw ||
        previous.binaryStrikeRaw !== next.binaryStrikeRaw
    );
}

function applyRoundLockGuard(
    previous: PredictRoundMarket | null,
    next: PredictRoundMarket,
): PredictRoundMarket {
    if (
        !previous?.currentOracle ||
        !previous.round ||
        !next.currentOracle ||
        !next.round ||
        previous.currentOracle.oracleId !== next.currentOracle.oracleId ||
        previous.round.roundId !== next.round.roundId
    ) {
        return next;
    }

    if (!hasRoundLockChanged(previous.round, next.round)) {
        return next;
    }

    return {
        ...previous,
        state: "ROUND_LOCK_ERROR",
        message: "Round unavailable",
        round: {
            ...previous.round,
            state: "ROUND_LOCK_ERROR",
        },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return value;
}

function readStringOrNull(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function readNumberOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function readNumber(value: unknown, fieldName: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return value;
}

function isRoundStatus(value: unknown): value is PredictRoundStatus {
    return (
        value === "LOADING" ||
        value === "NO_ACTIVE_ROUND" ||
        value === "LOCKING_ROUND" ||
        value === "BETTING_OPEN" ||
        value === "FINAL_LIVE" ||
        value === "PRICE_FEED_ERROR" ||
        value === "AWAITING_SETTLEMENT" ||
        value === "ROUND_LOCK_ERROR" ||
        value === "ROUND_DATA_ERROR" ||
        value === "ERROR"
    );
}

function parseOracleSummary(value: unknown): PredictOracleSummary | null {
    if (value === null) {
        return null;
    }
    if (!isRecord(value)) {
        throw new Error("Invalid oracle summary");
    }
    return {
        oracleId: readString(value.oracleId, "oracleId"),
        expiryMs: readNumber(value.expiryMs, "expiryMs"),
    };
}

function parsePreviousOracle(value: unknown): PredictPreviousOracle | null {
    if (value === null) {
        return null;
    }
    if (!isRecord(value)) {
        throw new Error("Invalid previous oracle");
    }
    const settlementPriceRaw = value.settlementPriceRaw;
    return {
        oracleId: readString(value.oracleId, "oracleId"),
        expiryMs: readNumber(value.expiryMs, "expiryMs"),
        lifecycle: readString(value.lifecycle, "lifecycle"),
        settlementPriceRaw: typeof settlementPriceRaw === "string" ? settlementPriceRaw : null,
    };
}

function parseCurrentOracle(value: unknown): PredictCurrentOracle | null {
    if (value === null) {
        return null;
    }
    if (!isRecord(value)) {
        throw new Error("Invalid currentOracle");
    }
    return {
        oracleId: readString(value.oracleId, "oracleId"),
        expiryMs: readNumber(value.expiryMs, "expiryMs"),
        lifecycle: readString(value.lifecycle, "lifecycle"),
        spotRaw: readStringOrNull(value.spotRaw),
        forwardRaw: readStringOrNull(value.forwardRaw),
        timestampMs: readNumberOrNull(value.timestampMs),
        minStrikeRaw: readStringOrNull(value.minStrikeRaw),
        tickSizeRaw: readStringOrNull(value.tickSizeRaw),
    };
}

function parseRoundDetails(value: unknown): PredictRoundDetails | null {
    if (value === null) {
        return null;
    }
    if (!isRecord(value) || !isRoundStatus(value.state)) {
        throw new Error("Invalid round details");
    }
    return {
        roundId: readString(value.roundId, "roundId"),
        currentOracleId: readString(value.currentOracleId, "currentOracleId"),
        previousOracleId: readString(value.previousOracleId, "previousOracleId"),
        roundOpenMs: readNumber(value.roundOpenMs, "roundOpenMs"),
        bettingCloseMs: readNumber(value.bettingCloseMs, "bettingCloseMs"),
        expiryMs: readNumber(value.expiryMs, "expiryMs"),
        openingSpotRaw: readString(value.openingSpotRaw, "openingSpotRaw"),
        binaryStrikeRaw: readString(value.binaryStrikeRaw, "binaryStrikeRaw"),
        minStrikeRaw: readString(value.minStrikeRaw, "minStrikeRaw"),
        tickSizeRaw: readString(value.tickSizeRaw, "tickSizeRaw"),
        state: value.state,
    };
}

function parseMarket(value: unknown): PredictRoundMarket {
    if (!isRecord(value) || !isRoundStatus(value.state)) {
        throw new Error("Invalid market response");
    }
    return {
        state: value.state,
        currentOracle: parseCurrentOracle(value.currentOracle ?? null),
        previousOracle: parsePreviousOracle(value.previousOracle ?? null),
        nextOracle: parseOracleSummary(value.nextOracle ?? null),
        round: parseRoundDetails(value.round ?? null),
        message: typeof value.message === "string" ? value.message : undefined,
        debug: isRecord(value.debug) ? value.debug : undefined,
    };
}

function countdownForMarket(market: PredictRoundMarket, nowMs: number): string | null {
    if (!market.currentOracle || !market.round) {
        return null;
    }
    if (market.state === "BETTING_OPEN") {
        return formatRoundCountdownClock(market.round.bettingCloseMs - nowMs);
    }
    if (market.state === "FINAL_LIVE") {
        return formatRoundCountdownClock(market.round.expiryMs - nowMs);
    }
    return null;
}

function progressForMarket(market: PredictRoundMarket | null, nowMs: number): number {
    if (!market?.round) {
        return 0;
    }
    const { roundOpenMs, expiryMs } = market.round;
    if (nowMs <= roundOpenMs) {
        return 0;
    }
    if (nowMs >= expiryMs) {
        return 100;
    }
    return Math.min(100, Math.max(0, ((nowMs - roundOpenMs) / (expiryMs - roundOpenMs)) * 100));
}

export function usePredictRound() {
    const [market, setMarket] = useState<PredictRoundMarket | null>(null);
    const [nowMs, setNowMs] = useState(Date.now());
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            const response = await fetch("/api/predict/btc-market", { cache: "no-store" });
            const payload = (await response.json()) as unknown;
            const nextMarket = parseMarket(payload);
            setMarket((current) => applyRoundLockGuard(current, nextMarket));
            setError(response.ok ? null : (nextMarket.message ?? "Round fetch failed"));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Round fetch failed");
        }
    }, []);

    useEffect(() => {
        void refresh();
        const refreshId = window.setInterval(() => void refresh(), 15_000);
        const tickId = window.setInterval(() => setNowMs(Date.now()), 1_000);
        return () => {
            window.clearInterval(refreshId);
            window.clearInterval(tickId);
        };
    }, [refresh]);

    useEffect(() => {
        if (!market?.round || nowMs < market.round.expiryMs) {
            return;
        }
        void refresh();
    }, [market?.round, nowMs, refresh]);

    return useMemo(
        () => ({
            market,
            error,
            nowMs,
            countdownLabel: market ? countdownForMarket(market, nowMs) : null,
            progressPercent: progressForMarket(market, nowMs),
            isBettingOpen: market?.state === "BETTING_OPEN",
            refresh,
        }),
        [error, market, nowMs, refresh],
    );
}
