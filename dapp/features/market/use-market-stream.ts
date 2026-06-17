"use client";

import { useEffect, useRef, useState } from "react";
import type { MarketReference } from "@/lib/market/config";
import { marketConfig } from "@/lib/market/config";
import { appendMarketPoint } from "@/lib/market/normalize";
import type {
    ChartPoint,
    MarketStreamEvent,
    MarketStreamStatus,
    MarketTick,
} from "@/lib/market/types";

type MarketConnectionStatus = Uppercase<MarketStreamStatus>;

export interface UseMarketStreamResult {
    status: MarketConnectionStatus;
    history: ChartPoint[];
    latestTick: MarketTick | null;
    message: string | null;
    oracleId: string | null;
    reference: MarketReference;
}

function parseMarketStreamEvent(input: unknown): MarketStreamEvent {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("Invalid market stream event");
    }
    const record = input as Record<string, unknown>;
    if (record.type === "status") {
        const status = record.status;
        if (
            status !== "connecting" &&
            status !== "live" &&
            status !== "stale" &&
            status !== "error"
        ) {
            throw new Error("Invalid market stream status");
        }
        const message = typeof record.message === "string" ? record.message : undefined;
        return { type: "status", status, message };
    }

    if (record.type === "tick") {
        return { type: "tick", tick: parseTick(record.tick) };
    }

    if (record.type === "snapshot") {
        const oracle = parseOracle(record.oracle);
        if (!Array.isArray(record.ticks)) {
            throw new Error("Invalid market snapshot");
        }
        return { type: "snapshot", oracle, ticks: record.ticks.map(parseTick) };
    }

    throw new Error("Invalid market stream event");
}

function parseTick(input: unknown): MarketTick {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("Invalid market tick");
    }
    const record = input as Record<string, unknown>;
    if (
        record.symbol !== "BTC/DUSDC" ||
        record.source !== "deepbook-predict-oracle" ||
        typeof record.price !== "number" ||
        !Number.isFinite(record.price) ||
        typeof record.rawSpot !== "string" ||
        typeof record.checkpoint !== "number" ||
        !Number.isFinite(record.checkpoint) ||
        typeof record.checkpointTimestampMs !== "number" ||
        !Number.isFinite(record.checkpointTimestampMs) ||
        typeof record.onchainTimestampMs !== "number" ||
        !Number.isFinite(record.onchainTimestampMs) ||
        typeof record.receivedAtMs !== "number" ||
        !Number.isFinite(record.receivedAtMs) ||
        typeof record.digest !== "string" ||
        typeof record.oracleId !== "string"
    ) {
        throw new Error("Invalid market tick");
    }

    return {
        symbol: record.symbol,
        price: record.price,
        rawSpot: record.rawSpot,
        checkpoint: record.checkpoint,
        checkpointTimestampMs: record.checkpointTimestampMs,
        onchainTimestampMs: record.onchainTimestampMs,
        receivedAtMs: record.receivedAtMs,
        digest: record.digest,
        oracleId: record.oracleId,
        source: record.source,
    };
}

function parseOracle(input: unknown): { oracleId: string; expiryMs: number } {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("Invalid market oracle");
    }
    const record = input as Record<string, unknown>;
    if (
        typeof record.oracleId !== "string" ||
        typeof record.expiryMs !== "number" ||
        !Number.isFinite(record.expiryMs)
    ) {
        throw new Error("Invalid market oracle");
    }
    return { oracleId: record.oracleId, expiryMs: record.expiryMs };
}

function toConnectionStatus(status: MarketStreamStatus): MarketConnectionStatus {
    return status.toUpperCase() as MarketConnectionStatus;
}

export function useMarketStream(currentOracleId: string | null): UseMarketStreamResult {
    const [status, setStatus] = useState<MarketConnectionStatus>("CONNECTING");
    const [history, setHistory] = useState<ChartPoint[]>([]);
    const [latestTick, setLatestTick] = useState<MarketTick | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [oracleId, setOracleId] = useState<string | null>(null);
    const pendingTickRef = useRef<MarketTick | null>(null);

    useEffect(() => {
        setStatus(currentOracleId ? "CONNECTING" : "ERROR");
        setHistory([]);
        setLatestTick(null);
        setMessage(currentOracleId ? null : "NO ACTIVE ROUND");
        setOracleId(currentOracleId);
        pendingTickRef.current = null;

        if (!currentOracleId) {
            return;
        }

        const eventSource = new EventSource(
            `/api/market/stream?oracleId=${encodeURIComponent(currentOracleId)}`,
        );
        const intervalId = window.setInterval(() => {
            const pendingTick = pendingTickRef.current;
            if (!pendingTick) {
                return;
            }
            if (pendingTick.oracleId !== currentOracleId) {
                return;
            }

            setHistory((current) => {
                const next = appendMarketPoint(current, pendingTick);
                if (next !== current) {
                    setLatestTick(pendingTick);
                }
                return next;
            });
        }, 500);

        eventSource.onmessage = (event) => {
            try {
                const parsed = parseMarketStreamEvent(JSON.parse(event.data) as unknown);
                if (parsed.type === "status") {
                    setStatus(toConnectionStatus(parsed.status));
                    setMessage(parsed.message ?? null);
                    return;
                }
                if (parsed.type === "snapshot") {
                    if (parsed.oracle.oracleId !== currentOracleId) {
                        throw new Error("Market stream oracle mismatch");
                    }
                    setHistory(parsed.ticks);
                    setLatestTick(parsed.ticks.at(-1) ?? null);
                    setOracleId(parsed.oracle.oracleId);
                    setMessage(null);
                    return;
                }
                if (parsed.tick.oracleId !== currentOracleId) {
                    throw new Error("Market tick oracle mismatch");
                }
                pendingTickRef.current = parsed.tick;
            } catch (caught) {
                setStatus("ERROR");
                setMessage(caught instanceof Error ? caught.message : "Invalid market data");
            }
        };

        eventSource.onerror = () => {
            setStatus((current) => (current === "LIVE" ? "STALE" : "ERROR"));
            setMessage("Market stream connection lost.");
        };

        return () => {
            window.clearInterval(intervalId);
            eventSource.close();
        };
    }, [currentOracleId]);

    return {
        status,
        history,
        latestTick,
        message,
        oracleId,
        reference: {
            symbol: marketConfig.symbol,
            currentPrice: latestTick?.price ?? null,
            status: status.toLowerCase() as MarketReference["status"],
            updatedAtMs: latestTick?.onchainTimestampMs ?? null,
        },
    };
}
