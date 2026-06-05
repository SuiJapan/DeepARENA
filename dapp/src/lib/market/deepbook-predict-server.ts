import "server-only";

import { marketConfig } from "./config";
import {
    isDuplicateOrOlderTick,
    normalizePredictPriceHistory,
    normalizePredictPriceTick,
    parsePredictPrice,
    selectActiveBtcOracle,
} from "./normalize";
import type { MarketStreamEvent, MarketTick, SelectedMarketOracle } from "./types";

type Listener = (event: MarketStreamEvent) => boolean;
type FetchJson = (url: string) => Promise<unknown>;

interface MarketStreamSession {
    close(): void;
}

class PredictMarketStreamSession implements MarketStreamSession {
    private latestTick: MarketTick | null = null;
    private oracle: SelectedMarketOracle | null = null;
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private staleTimer: ReturnType<typeof setInterval> | null = null;
    private isPolling = false;
    private backoffMs: number = marketConfig.initialBackoffMs;
    private stopped = false;
    private lastOracleRefreshMs = 0;
    private activeRequest: AbortController | null = null;

    constructor(private readonly listener: Listener) {}

    start() {
        this.emitStatus("connecting");
        if (this.stopped) {
            return;
        }
        void this.bootstrap();
    }

    close() {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.staleTimer) {
            clearInterval(this.staleTimer);
            this.staleTimer = null;
        }
        this.activeRequest?.abort();
        this.activeRequest = null;
    }

    private async bootstrap() {
        if (this.stopped) {
            return;
        }
        try {
            const oracle = await this.resolveOracle(true);
            if (this.stopped) {
                return;
            }
            const receivedAtMs = Date.now();
            const history = await fetchPriceHistory(oracle.oracleId, receivedAtMs, (url) =>
                this.fetchJson(url),
            );
            if (this.stopped) {
                return;
            }
            if (history.length === 0) {
                throw new Error("Predict server returned empty price history");
            }
            this.latestTick = history.at(-1) ?? null;
            this.emitSnapshot(oracle, history);
            this.emitStatus(this.isLatestTickLive() ? "live" : "stale");
            this.backoffMs = marketConfig.initialBackoffMs;
            this.startStaleTimer();
            this.schedulePoll(marketConfig.latestPollIntervalMs);
        } catch (caught) {
            if (this.stopped) {
                return;
            }
            console.error("Market snapshot failed:", safeLogMessage(caught));
            this.emitStatus("error", "Price feed temporarily unavailable");
            this.schedulePoll(this.backoffMs);
            this.increaseBackoff();
        }
    }

    private async pollLatest() {
        if (this.stopped || this.isPolling) {
            return;
        }
        this.isPolling = true;

        try {
            const oracle = await this.resolveOracle(false);
            if (this.stopped) {
                return;
            }
            const tick = await fetchLatestPrice(oracle.oracleId, Date.now(), (url) =>
                this.fetchJson(url),
            );
            if (this.stopped) {
                return;
            }
            if (tick && (!this.latestTick || !isDuplicateOrOlderTick(this.latestTick, tick))) {
                this.latestTick = tick;
                this.emitTick(tick);
                this.emitStatus("live");
            } else {
                this.emitStatus(this.isLatestTickLive() ? "live" : "stale");
            }
            this.backoffMs = marketConfig.initialBackoffMs;
            this.schedulePoll(marketConfig.latestPollIntervalMs);
        } catch (caught) {
            if (this.stopped) {
                return;
            }
            console.error("Market latest price failed:", safeLogMessage(caught));
            this.emitStatus(
                this.latestTick ? "stale" : "error",
                "Price feed temporarily unavailable",
            );
            this.oracle = null;
            this.schedulePoll(this.backoffMs);
            this.increaseBackoff();
        } finally {
            this.isPolling = false;
        }
    }

    private async resolveOracle(force: boolean): Promise<SelectedMarketOracle> {
        const nowMs = Date.now();
        if (
            !force &&
            this.oracle &&
            this.oracle.expiryMs > nowMs &&
            nowMs - this.lastOracleRefreshMs < marketConfig.oracleRefreshIntervalMs
        ) {
            return this.oracle;
        }

        const oracle = await fetchActiveBtcOracle(nowMs, (url) => this.fetchJson(url));
        this.oracle = oracle;
        this.lastOracleRefreshMs = nowMs;
        return oracle;
    }

    private schedulePoll(delayMs: number) {
        if (this.stopped) {
            return;
        }
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }
        this.pollTimer = setTimeout(() => {
            this.pollTimer = null;
            void this.pollLatest();
        }, delayMs);
    }

    private startStaleTimer() {
        if (this.staleTimer) {
            return;
        }
        this.staleTimer = setInterval(() => {
            if (!this.stopped && this.latestTick && !this.isLatestTickLive()) {
                this.emitStatus("stale");
            }
        }, 1000);
    }

    private isLatestTickLive(): boolean {
        return Boolean(
            this.latestTick &&
                Date.now() - this.latestTick.onchainTimestampMs < marketConfig.staleAfterMs,
        );
    }

    private increaseBackoff() {
        this.backoffMs = Math.min(this.backoffMs * 2, marketConfig.maxBackoffMs);
    }

    private emitSnapshot(oracle: SelectedMarketOracle, ticks: MarketTick[]) {
        this.emit({ type: "snapshot", oracle, ticks });
    }

    private emitTick(tick: MarketTick) {
        this.emit({ type: "tick", tick });
    }

    private emitStatus(status: "connecting" | "live" | "stale" | "error", message?: string) {
        this.emit({ type: "status", status, message });
    }

    private emit(event: MarketStreamEvent) {
        if (this.stopped) {
            return;
        }
        if (!this.listener(event)) {
            this.close();
        }
    }

    private async fetchJson(url: string): Promise<unknown> {
        if (this.stopped) {
            throw new Error("Market stream stopped");
        }
        const controller = new AbortController();
        this.activeRequest = controller;
        try {
            return await fetchJson(url, controller.signal);
        } finally {
            if (this.activeRequest === controller) {
                this.activeRequest = null;
            }
        }
    }
}

async function fetchActiveBtcOracle(
    nowMs: number,
    fetchJsonFn: FetchJson,
): Promise<SelectedMarketOracle> {
    return selectActiveBtcOracle(
        await fetchJsonFn(
            `${marketConfig.predictServerUrl}/predicts/${marketConfig.predictId}/oracles`,
        ),
        nowMs,
    );
}

async function fetchPriceHistory(
    oracleId: string,
    receivedAtMs: number,
    fetchJsonFn: FetchJson,
): Promise<MarketTick[]> {
    return normalizePredictPriceHistory(
        await fetchJsonFn(`${marketConfig.predictServerUrl}/oracles/${oracleId}/prices`),
        receivedAtMs,
    );
}

async function fetchLatestPrice(
    oracleId: string,
    receivedAtMs: number,
    fetchJsonFn: FetchJson,
): Promise<MarketTick> {
    return normalizePredictPriceTick(
        parsePredictPrice(
            await fetchJsonFn(`${marketConfig.predictServerUrl}/oracles/${oracleId}/prices/latest`),
        ),
        receivedAtMs,
    );
}

async function fetchJson(url: string, parentSignal: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), marketConfig.requestTimeoutMs);
    const abort = () => controller.abort();
    parentSignal.addEventListener("abort", abort, { once: true });
    try {
        const response = await fetch(url, {
            headers: { accept: "application/json" },
            signal: controller.signal,
            cache: "no-store",
        });
        if (response.status === 429 || response.status >= 500) {
            throw new Error(`Predict server temporary failure: ${response.status}`);
        }
        if (!response.ok) {
            throw new Error(`Predict server request failed: ${response.status}`);
        }
        return (await response.json()) as unknown;
    } finally {
        clearTimeout(timeoutId);
        parentSignal.removeEventListener("abort", abort);
    }
}

function safeLogMessage(caught: unknown): string {
    return caught instanceof Error ? caught.message : "Unknown market stream error";
}

export function createDeepbookPredictMarketStream(listener: Listener): MarketStreamSession {
    const session = new PredictMarketStreamSession(listener);
    session.start();
    return session;
}
