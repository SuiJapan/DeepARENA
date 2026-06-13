"use client";

import { formatMarketPrice, marketConfig } from "@/src/lib/market/config";
import { calculateChangePercent, calculateChartPath } from "@/src/lib/market/normalize";
import type { UseMarketStreamResult } from "./use-market-stream";

const percentFormatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: "always",
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Tokyo",
    timeZoneName: "short",
});

const chartAxisSlots = ["start", "middle", "end"] as const;

function rawPriceToNumber(raw: string | null): number | null {
    if (raw === null) {
        return null;
    }
    const scale = 1_000_000_000n;
    const value = BigInt(raw);
    return Number(value / scale) + Number(value % scale) / Number(scale);
}

function calculateReferenceLineY(history: UseMarketStreamResult["history"], strike: number | null) {
    if (history.length === 0 || strike === null) {
        return null;
    }
    const prices = [...history.map((point) => point.price), strike];
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const midpoint = (minPrice + maxPrice) / 2;
    const rawRange = maxPrice - minPrice;
    const range = Math.max(rawRange, Math.max(midpoint * 0.002, 0.0001));
    const minYPrice = midpoint - range / 2;
    return 260 - Math.min(Math.max((strike - minYPrice) / range, 0), 1) * 260;
}

export function MarketChart({
    binaryStrikeRaw,
    market,
}: {
    binaryStrikeRaw: string | null;
    market: UseMarketStreamResult;
}) {
    const { status, history, latestTick, message, oracleId } = market;
    const changePercent = calculateChangePercent(history);
    const chart = calculateChartPath(history, 800, 260);
    const strike = rawPriceToNumber(binaryStrikeRaw);
    const strikeLineY = calculateReferenceLineY(history, strike);
    const changeDirection =
        changePercent === null || Math.abs(changePercent) < 0.000001
            ? "flat"
            : changePercent > 0
              ? "up"
              : "down";
    const priceLabel = latestTick
        ? `${formatMarketPrice(latestTick.price)} ${marketConfig.quoteAsset}`
        : "--";
    const changeLabel =
        changePercent === null ? "Collecting" : `${percentFormatter.format(changePercent)}%`;
    const lastUpdatedLabel = latestTick
        ? timeFormatter.format(new Date(latestTick.onchainTimestampMs))
        : "Waiting";
    const statusMessage = message ?? oracleId ?? marketConfig.sourceLabel;

    return (
        <section className="surface market-chart">
            <div className="section-title">
                <div>
                    <span>Market view</span>
                    <h2>{marketConfig.displaySymbol}</h2>
                    <small>{marketConfig.sourceLabel}</small>
                </div>
                <div className="market-quote" data-direction={changeDirection}>
                    <strong>{priceLabel}</strong>
                    <small>{changeLabel}</small>
                </div>
            </div>
            <div className="timeframe-row">
                <button type="button" data-active="true" aria-pressed="true">
                    LIVE
                </button>
                {(["1H", "1D", "1W", "1M"] as const).map((label) => (
                    <button
                        type="button"
                        key={label}
                        disabled
                        title={`${label} history is not implemented for the live DeepBook Predict stream yet.`}
                        aria-label={`${label} history is not implemented for the live DeepBook Predict stream yet.`}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <div className="market-stream-meta">
                <span className="market-status" data-status={status}>
                    {status}
                </span>
                <span>{lastUpdatedLabel}</span>
                <span>{statusMessage}</span>
            </div>
            <div className="chart-area">
                {history.length === 0 ? (
                    <div className="chart-empty" aria-live="polite">
                        {status === "ERROR" ? statusMessage : "Collecting oracle ticks..."}
                    </div>
                ) : null}
                <svg viewBox="0 0 800 260" role="img" aria-label="Live BTC price chart">
                    <defs>
                        <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1">
                            <stop offset="0%" stopColor="#31a98b" stopOpacity="0.28" />
                            <stop offset="100%" stopColor="#31a98b" stopOpacity="0" />
                        </linearGradient>
                    </defs>
                    {chart.fillPath ? <path className="chart-fill" d={chart.fillPath} /> : null}
                    {chart.linePath ? <path className="chart-line" d={chart.linePath} /> : null}
                    {strikeLineY !== null ? (
                        <line
                            className="chart-reference-line"
                            x1="0"
                            x2="800"
                            y1={strikeLineY}
                            y2={strikeLineY}
                        />
                    ) : null}
                    {chart.lastPoint ? (
                        <circle
                            className="chart-last-point"
                            cx={chart.lastPoint.x}
                            cy={chart.lastPoint.y}
                            r="5"
                        />
                    ) : null}
                </svg>
                <div className="chart-axis">
                    {chartAxisSlots.map((slot, index) => {
                        const point =
                            history.length > 0
                                ? [
                                      history[0],
                                      history[Math.floor(history.length / 2)],
                                      history.at(-1),
                                  ][index]
                                : null;
                        return (
                            <span key={slot}>
                                {point
                                    ? timeFormatter.format(new Date(point.onchainTimestampMs))
                                    : "--"}
                            </span>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}
