import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateMarketRange, formatMarketPrice, marketConfig } from "./config";
import {
    appendMarketPoint,
    calculateChangePercent,
    calculateChartPath,
    convertSpotToPrice,
    normalizePredictPriceHistory,
    normalizePredictPriceTick,
    parsePredictPrice,
    selectActiveBtcOracle,
} from "./normalize";
import type { ChartPoint, MarketTick } from "./types";

function price(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        event_digest: "event",
        digest: "digest-1",
        sender: "0xsender",
        checkpoint: 10,
        checkpoint_timestamp_ms: 1_760_000_000_000,
        tx_index: 0,
        event_index: 0,
        package: "0xpackage",
        oracle_id: "0xoracle",
        spot: 59_972_071_172_765,
        forward: 60_000_000_000_000,
        onchain_timestamp: 1_760_000_000_100,
        ...overrides,
    };
}

function tick({
    digest,
    priceValue,
    checkpoint,
    onchainTimestampMs,
}: {
    digest: string;
    priceValue: number;
    checkpoint: number;
    onchainTimestampMs: number;
}): MarketTick {
    return {
        symbol: "BTC/DUSDC",
        price: priceValue,
        rawSpot: String(Math.round(priceValue * 1_000_000_000)),
        checkpoint,
        checkpointTimestampMs: onchainTimestampMs - 10,
        onchainTimestampMs,
        receivedAtMs: onchainTimestampMs + 5,
        digest,
        oracleId: "0xoracle",
        source: "deepbook-predict-oracle",
    };
}

describe("market normalization", () => {
    it("uses the BTC/DUSDC market configuration", () => {
        assert.equal(marketConfig.symbol, "BTC/DUSDC");
        assert.equal(marketConfig.displaySymbol, "BTC / DUSDC");
    });

    it("formats BTC prices for display", () => {
        assert.equal(formatMarketPrice(59972.071172765), "59,972.07");
    });

    it("calculates fixed range bounds from strike", () => {
        const range = calculateMarketRange(60_000);
        assert.equal(range.lower, 59_850);
        assert.ok(Math.abs(range.upper - 60_150) < 0.000001);
    });

    it("converts spot scaling into a display BTC price", () => {
        assert.equal(convertSpotToPrice("59972071172765"), 59972.071172765);
    });

    it("rejects invalid spot values", () => {
        assert.throws(() => parsePredictPrice(price({ spot: 0 })), /Invalid spot/);
        assert.throws(() => parsePredictPrice(price({ spot: -1 })), /Invalid spot/);
        assert.throws(
            () => parsePredictPrice(price({ spot: Number.MAX_SAFE_INTEGER + 1 })),
            /Invalid spot/,
        );
    });

    it("rejects invalid timestamps", () => {
        assert.throws(
            () => parsePredictPrice(price({ onchain_timestamp: 0 })),
            /Invalid onchain_timestamp/,
        );
    });

    it("normalizes a Predict price row without using forward", () => {
        const tick = normalizePredictPriceTick(parsePredictPrice(price({ forward: 1 })), 123);
        assert.equal(tick.symbol, "BTC/DUSDC");
        assert.equal(tick.price, 59972.071172765);
        assert.equal(tick.rawSpot, "59972071172765");
        assert.equal(tick.source, "deepbook-predict-oracle");
    });

    it("sorts history oldest first and removes duplicate digests", () => {
        const history = normalizePredictPriceHistory(
            [
                price({
                    digest: "digest-2",
                    checkpoint: 2,
                    onchain_timestamp: 2000,
                }),
                price({
                    digest: "digest-1",
                    checkpoint: 1,
                    onchain_timestamp: 1000,
                }),
                price({
                    digest: "digest-1",
                    checkpoint: 1,
                    onchain_timestamp: 1000,
                }),
            ],
            3000,
        );
        assert.deepEqual(
            history.map((tick) => tick.digest),
            ["digest-1", "digest-2"],
        );
    });

    it("rejects timestamp regression when appending live ticks", () => {
        const history = appendMarketPoint(
            [
                tick({
                    digest: "digest-2",
                    priceValue: 2,
                    checkpoint: 2,
                    onchainTimestampMs: 2000,
                }),
            ],
            tick({
                digest: "digest-3",
                priceValue: 3,
                checkpoint: 3,
                onchainTimestampMs: 1000,
            }),
        );
        assert.equal(history.length, 1);
        assert.equal(history[0]?.digest, "digest-2");
    });

    it("excludes duplicate digest ticks", () => {
        const first = tick({
            digest: "digest-1",
            priceValue: 2,
            checkpoint: 1,
            onchainTimestampMs: 1000,
        });
        const history = appendMarketPoint([], first);
        assert.equal(appendMarketPoint(history, first), history);
    });

    it("trims history to the latest 120 points", () => {
        const history = Array.from({ length: 130 }, (_, index) =>
            tick({
                digest: `digest-${index}`,
                priceValue: 50_000 + index,
                checkpoint: index,
                onchainTimestampMs: 1_000 + index,
            }),
        ).reduce<ChartPoint[]>((current, point) => appendMarketPoint(current, point), []);

        assert.equal(history.length, 120);
        assert.equal(history[0]?.digest, "digest-10");
    });

    it("calculates change percent against the first retained price", () => {
        assert.equal(
            calculateChangePercent([
                tick({
                    digest: "digest-1",
                    priceValue: 100,
                    checkpoint: 1,
                    onchainTimestampMs: 1000,
                }),
                tick({
                    digest: "digest-2",
                    priceValue: 105,
                    checkpoint: 2,
                    onchainTimestampMs: 2000,
                }),
            ]),
            5,
        );
    });

    it("calculates stable chart coordinates when every price is equal", () => {
        const chart = calculateChartPath(
            [
                tick({
                    digest: "digest-1",
                    priceValue: 100,
                    checkpoint: 1,
                    onchainTimestampMs: 1000,
                }),
                tick({
                    digest: "digest-2",
                    priceValue: 100,
                    checkpoint: 2,
                    onchainTimestampMs: 2000,
                }),
            ],
            800,
            260,
        );
        assert.equal(chart.lastPoint?.x, 800);
        assert.ok(chart.lastPoint && Math.abs(chart.lastPoint.y - 130) < 0.000001);
    });

    it("selects active BTC oracle with the longest expiry", () => {
        const selected = selectActiveBtcOracle(
            [
                {
                    predict_id: "0xpredict",
                    oracle_id: "0xshort",
                    oracle_cap_id: "0xcap",
                    underlying_asset: "BTC",
                    expiry: 3000,
                    min_strike: 0,
                    tick_size: 1,
                    status: "active",
                    activated_at: 1,
                    settlement_price: null,
                    settled_at: null,
                    created_checkpoint: 1,
                },
                {
                    predict_id: "0xpredict",
                    oracle_id: "0xlong",
                    oracle_cap_id: "0xcap",
                    underlying_asset: "BTC",
                    expiry: 5000,
                    min_strike: 0,
                    tick_size: 1,
                    status: "active",
                    activated_at: 1,
                    settlement_price: null,
                    settled_at: null,
                    created_checkpoint: 1,
                },
                {
                    predict_id: "0xpredict",
                    oracle_id: "0xeth",
                    oracle_cap_id: "0xcap",
                    underlying_asset: "ETH",
                    expiry: 6000,
                    min_strike: 0,
                    tick_size: 1,
                    status: "active",
                    activated_at: 1,
                    settlement_price: null,
                    settled_at: null,
                    created_checkpoint: 1,
                },
            ],
            1000,
        );
        assert.equal(selected.oracleId, "0xlong");
    });

    it("throws when no active BTC oracle exists", () => {
        assert.throws(
            () =>
                selectActiveBtcOracle(
                    [
                        {
                            predict_id: "0xpredict",
                            oracle_id: "0xexpired",
                            oracle_cap_id: "0xcap",
                            underlying_asset: "BTC",
                            expiry: 1000,
                            min_strike: 0,
                            tick_size: 1,
                            status: "active",
                            activated_at: 1,
                            settlement_price: null,
                            settled_at: null,
                            created_checkpoint: 1,
                        },
                    ],
                    2000,
                ),
            /No active BTC oracle/,
        );
    });
});
