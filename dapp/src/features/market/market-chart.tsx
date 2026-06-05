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
});

export function MarketChart({ market }: { market: UseMarketStreamResult }) {
    const { status, history, latestTick, message, oracleId } = market;
    const changePercent = calculateChangePercent(history);
    const chart = calculateChartPath(history, 800, 260);
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
                    <span>-100s</span>
                    <span>-75s</span>
                    <span>-50s</span>
                    <span>-25s</span>
                    <span>Now</span>
                </div>
            </div>
        </section>
    );
}
