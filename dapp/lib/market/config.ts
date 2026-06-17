export const marketConfig = {
    underlyingAsset: "BTC",
    quoteAsset: "DUSDC",
    symbol: "BTC/DUSDC",
    displaySymbol: "BTC / DUSDC",
    priceDecimals: 2,
    priceScale: 1_000_000_000,
    sourceLabel: "DeepBook Predict Oracle",
    rangePercent: 0.0025,
    predictServerUrl: "https://predict-server.testnet.mystenlabs.com",
    predictId: "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a",
    latestPollIntervalMs: 1_000,
    oracleRefreshIntervalMs: 60_000,
    staleAfterMs: 5_000,
    requestTimeoutMs: 8_000,
    initialBackoffMs: 1_000,
    maxBackoffMs: 15_000,
} as const;

export type MarketReference = {
    symbol: typeof marketConfig.symbol;
    currentPrice: number | null;
    status: "connecting" | "live" | "stale" | "error";
    updatedAtMs: number | null;
};

export function formatMarketPrice(price: number): string {
    return new Intl.NumberFormat("en-US", {
        minimumFractionDigits: marketConfig.priceDecimals,
        maximumFractionDigits: marketConfig.priceDecimals,
    }).format(price);
}

export function calculateMarketRange(strikePrice: number): { lower: number; upper: number } {
    return {
        lower: strikePrice * (1 - marketConfig.rangePercent),
        upper: strikePrice * (1 + marketConfig.rangePercent),
    };
}
