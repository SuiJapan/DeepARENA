import type { ChartPoint, MarketTick, SelectedMarketOracle } from "./types";

const marketSymbol = "BTC/DUSDC" as const;
const maxHistoryPoints = 120;
const spotScale = BigInt(1_000_000_000);
const maxU64 = BigInt("18446744073709551615");

type UnknownRecord = Record<string, unknown>;

export interface PredictOracle {
    predictId: string;
    oracleId: string;
    underlyingAsset: string;
    expiryMs: number;
    status: string;
}

export interface PredictPrice {
    digest: string;
    checkpoint: number;
    checkpointTimestampMs: number;
    oracleId: string;
    spot: number;
    onchainTimestampMs: number;
    eventIndex: number;
}

export function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseU64String(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
        throw new Error(`Invalid ${fieldName}`);
    }
    const parsed = BigInt(value);
    if (parsed > maxU64) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return value;
}

function parseSafePositiveInteger(value: unknown, fieldName: string): number {
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        !Number.isFinite(value)
    ) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return value;
}

function parseSafeNonNegativeInteger(value: unknown, fieldName: string): number {
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        !Number.isFinite(value)
    ) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return value;
}

function parseRequiredString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return value;
}

function parsePositiveU64String(value: unknown, fieldName: string): string {
    const parsed = parseU64String(value, fieldName);
    if (BigInt(parsed) === BigInt(0)) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return parsed;
}

export function convertSpotToPrice(rawSpot: string): number {
    const spot = BigInt(parsePositiveU64String(rawSpot, "spot"));
    const whole = spot / spotScale;
    const fractional = spot % spotScale;
    const price = Number(whole) + Number(fractional) / Number(spotScale);
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error("Invalid display price");
    }
    return price;
}

export function parsePredictOracle(input: unknown): PredictOracle {
    if (!isRecord(input)) {
        throw new Error("Invalid oracle");
    }
    return {
        predictId: parseRequiredString(input.predict_id, "predict_id"),
        oracleId: parseRequiredString(input.oracle_id, "oracle_id"),
        underlyingAsset: parseRequiredString(input.underlying_asset, "underlying_asset"),
        expiryMs: parseSafePositiveInteger(input.expiry, "expiry"),
        status: parseRequiredString(input.status, "status"),
    };
}

export function parsePredictPrice(input: unknown): PredictPrice {
    if (!isRecord(input)) {
        throw new Error("Invalid price");
    }
    const spot = parseSafePositiveInteger(input.spot, "spot");
    return {
        digest: parseRequiredString(input.digest, "digest"),
        checkpoint: parseSafeNonNegativeInteger(input.checkpoint, "checkpoint"),
        checkpointTimestampMs: parseSafePositiveInteger(
            input.checkpoint_timestamp_ms,
            "checkpoint_timestamp_ms",
        ),
        oracleId: parseRequiredString(input.oracle_id, "oracle_id"),
        spot,
        onchainTimestampMs: parseSafePositiveInteger(input.onchain_timestamp, "onchain_timestamp"),
        eventIndex: parseSafeNonNegativeInteger(input.event_index, "event_index"),
    };
}

export function normalizePredictPriceTick(input: PredictPrice, receivedAtMs: number): MarketTick {
    if (!Number.isFinite(receivedAtMs) || receivedAtMs <= 0) {
        throw new Error("Invalid receivedAtMs");
    }
    const rawSpot = parsePositiveU64String(String(input.spot), "spot");
    return {
        symbol: marketSymbol,
        price: convertSpotToPrice(rawSpot),
        rawSpot,
        checkpoint: input.checkpoint,
        checkpointTimestampMs: input.checkpointTimestampMs,
        onchainTimestampMs: input.onchainTimestampMs,
        receivedAtMs,
        digest: input.digest,
        oracleId: input.oracleId,
        source: "deepbook-predict-oracle",
    };
}

export function isDuplicateOrOlderTick(previous: ChartPoint | null, next: MarketTick): boolean {
    if (!previous) {
        return false;
    }
    if (next.onchainTimestampMs < previous.onchainTimestampMs) {
        return true;
    }
    return (
        next.digest === previous.digest ||
        (next.checkpoint === previous.checkpoint &&
            next.onchainTimestampMs === previous.onchainTimestampMs)
    );
}

export function appendMarketPoint(history: ChartPoint[], tick: MarketTick): ChartPoint[] {
    const previous = history.at(-1) ?? null;
    if (isDuplicateOrOlderTick(previous, tick)) {
        return history;
    }

    const nextHistory = [
        ...history,
        {
            price: tick.price,
            rawSpot: tick.rawSpot,
            checkpoint: tick.checkpoint,
            checkpointTimestampMs: tick.checkpointTimestampMs,
            onchainTimestampMs: tick.onchainTimestampMs,
            receivedAtMs: tick.receivedAtMs,
            digest: tick.digest,
            oracleId: tick.oracleId,
        },
    ];

    return nextHistory.slice(-maxHistoryPoints);
}

export function normalizePredictPriceHistory(input: unknown, receivedAtMs: number): MarketTick[] {
    if (!Array.isArray(input)) {
        throw new Error("Invalid price history");
    }

    const parsed = input
        .map((price) => {
            try {
                return parsePredictPrice(price);
            } catch {
                return null;
            }
        })
        .filter((price): price is PredictPrice => price !== null)
        .sort((left, right) => left.onchainTimestampMs - right.onchainTimestampMs);

    const seenDigests = new Set<string>();
    const seenPositions = new Set<string>();

    const ticks: MarketTick[] = [];
    for (const price of parsed) {
        const positionKey = `${price.checkpoint}:${price.eventIndex}`;
        if (seenDigests.has(price.digest) || seenPositions.has(positionKey)) {
            continue;
        }
        const nextTick = normalizePredictPriceTick(price, receivedAtMs);
        const previous = ticks.at(-1);
        if (previous && isDuplicateOrOlderTick(previous, nextTick)) {
            continue;
        }
        seenDigests.add(price.digest);
        seenPositions.add(positionKey);
        ticks.push(nextTick);
        if (ticks.length > maxHistoryPoints) {
            ticks.shift();
        }
    }
    return ticks;
}

export function selectActiveBtcOracle(input: unknown, nowMs: number): SelectedMarketOracle {
    if (!Array.isArray(input)) {
        throw new Error("Invalid oracle list");
    }
    const activeOracles = input
        .map(parsePredictOracle)
        .filter(
            (oracle) =>
                oracle.underlyingAsset === "BTC" &&
                oracle.status === "active" &&
                oracle.expiryMs > nowMs,
        )
        .sort((left, right) => right.expiryMs - left.expiryMs);
    const selected = activeOracles[0];
    if (!selected) {
        throw new Error("No active BTC oracle found");
    }
    return { oracleId: selected.oracleId, expiryMs: selected.expiryMs };
}

export function calculateChangePercent(history: ChartPoint[]): number | null {
    const first = history[0];
    const last = history.at(-1);
    if (!first || !last || first.price <= 0) {
        return null;
    }
    return ((last.price - first.price) / first.price) * 100;
}

export function calculateChartPath(
    history: ChartPoint[],
    width: number,
    height: number,
): { linePath: string; fillPath: string; lastPoint: { x: number; y: number } | null } {
    if (history.length === 0 || width <= 0 || height <= 0) {
        return { linePath: "", fillPath: "", lastPoint: null };
    }

    const prices = history.map((point) => point.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const midpoint = (minPrice + maxPrice) / 2;
    const rawRange = maxPrice - minPrice;
    const minimumRange = Math.max(midpoint * 0.002, 0.0001);
    const range = Math.max(rawRange, minimumRange);
    const minYPrice = midpoint - range / 2;
    const xStep = history.length > 1 ? width / (history.length - 1) : 0;

    const coordinates = history.map((point, index) => {
        const x = history.length > 1 ? index * xStep : width;
        const normalized = (point.price - minYPrice) / range;
        const y = height - Math.min(Math.max(normalized, 0), 1) * height;
        return { x, y };
    });

    const linePath = coordinates
        .map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`)
        .join(" ");
    const fillPath = `${linePath} L${coordinates.at(-1)?.x ?? width} ${height} L${
        coordinates[0]?.x ?? 0
    } ${height} Z`;

    return {
        linePath,
        fillPath,
        lastPoint: coordinates.at(-1) ?? null,
    };
}
