export type MarketSymbol = "BTC/DUSDC";
export type MarketSource = "deepbook-predict-oracle";
export type MarketStreamStatus = "connecting" | "live" | "stale" | "error";

export interface MarketTick {
    symbol: MarketSymbol;
    price: number;
    rawSpot: string;
    checkpoint: number;
    checkpointTimestampMs: number;
    onchainTimestampMs: number;
    receivedAtMs: number;
    digest: string;
    oracleId: string;
    source: MarketSource;
}

export type MarketStreamEvent =
    | {
          type: "snapshot";
          oracle: {
              oracleId: string;
              expiryMs: number;
          };
          ticks: MarketTick[];
      }
    | {
          type: "tick";
          tick: MarketTick;
      }
    | {
          type: "status";
          status: MarketStreamStatus;
          message?: string;
      };

export interface ChartPoint {
    price: number;
    rawSpot: string;
    checkpoint: number;
    checkpointTimestampMs: number;
    onchainTimestampMs: number;
    receivedAtMs: number;
    digest: string;
    oracleId: string;
}

export interface SelectedMarketOracle {
    oracleId: string;
    expiryMs: number;
}
