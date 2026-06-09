import { NextResponse } from "next/server";
import { PREDICT_BINARY_CONFIG } from "@/src/lib/predict-binary/config";
import {
    buildSettlementRoundLock,
    calculateBettingClose,
    calculateRoundOpen,
    getRoundStatus,
    type OracleCandidate,
    type PredictRoundStatus,
    selectCurrentBtcOracle,
} from "@/src/lib/predict-round/round";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface OracleSummary {
    oracleId: string;
    expiryMs: number;
}

interface PreviousOracleResponse extends OracleSummary {
    lifecycle: string;
    settlementPriceRaw: string | null;
}

interface CurrentOracleResponse extends OracleSummary {
    lifecycle: string;
    spotRaw: string | null;
    forwardRaw: string | null;
    timestampMs: number | null;
    minStrikeRaw: string | null;
    tickSizeRaw: string | null;
}

interface RoundDetailsResponse {
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

interface MarketResponse {
    state: PredictRoundStatus;
    currentOracle: CurrentOracleResponse | null;
    previousOracle: PreviousOracleResponse | null;
    nextOracle: OracleSummary | null;
    round: RoundDetailsResponse | null;
    message?: string;
    debug?: {
        reason: string;
        originalErrorMessage?: string;
        previousOracleStateSource?: string;
        previousOracleStateFetchError?: string;
        previousOracleObjectFetchError?: string;
        searchedEventCount?: number;
        searchedPages?: number;
        targetOracleId?: string;
        lastCursor?: unknown;
        matchedOracleCreatedEventFound?: boolean;
        matchedOracleId?: string | null;
        exactMatchFound?: boolean;
        fallbackCandidateFound?: boolean;
        fallbackReason?: string;
        fallbackOracleId?: string;
        fallbackExpiry?: number;
        fallbackUnderlyingAsset?: string;
        lastSeenOracleId?: string | null;
        parsedFieldNames?: string[];
        gridFailureReason?: string;
        gridSource?: string;
        minStrikeRaw?: string;
        tickSizeRaw?: string;
        settlementPriceRawShape?: string;
        settlementPriceParseError?: string | null;
        suiGetObjectCalled?: boolean;
        suiGetObjectMethod?: string;
        previousOracleObjectId?: string;
        rawSettlementPricePathValue?: unknown;
        rawSettlementPriceType?: string;
        parseFailureReason?: string | null;
    };
}

interface OracleGrid {
    oracleId: string;
    minStrikeRaw: string;
    tickSizeRaw: string;
    source: "oracle_created_exact" | "oracle_created_underlying_fallback";
    fallbackOracleId?: string;
    fallbackExpiryMs?: number;
    fallbackUnderlyingAsset?: string;
    debug: OracleGridSearchDebug;
}

interface OracleGridSearchDebug {
    reason: string;
    targetOracleId: string;
    searchedEventCount: number;
    searchedPages: number;
    lastCursor: unknown;
    matchedOracleCreatedEventFound: boolean;
    matchedOracleId: string | null;
    exactMatchFound: boolean;
    fallbackCandidateFound: boolean;
    fallbackReason?: string;
    fallbackOracleId?: string;
    fallbackExpiry?: number;
    fallbackUnderlyingAsset?: string;
    lastSeenOracleId: string | null;
    parsedFieldNames: string[];
    gridSource?: OracleGrid["source"];
    minStrikeRaw?: string;
    tickSizeRaw?: string;
}

interface OraclePrice {
    spotRaw: string;
    forwardRaw: string | null;
    onchainTimestampMs: number;
}

interface OracleState {
    lifecycle: string;
    settlementPriceRaw: string | null;
    settlementPriceParseError: string | null;
    source: string;
    rawState: unknown;
    rawSettlementPrice: unknown;
    rawSettlementPriceCamel: unknown;
    rawSettlementPriceRaw: unknown;
    rawSettlementPriceSnakeRaw: unknown;
    rawSettlementPricePathValue?: unknown;
}

type FetchResult<T> =
    | { ok: true; value: T }
    | { ok: false; message: string; debug?: unknown };

class OracleGridFetchError extends Error {
    constructor(
        message: string,
        readonly debug: OracleGridSearchDebug,
    ) {
        super(message);
        this.name = "OracleGridFetchError";
    }
}

const oracleGridByOracleIdCache = new Map<string, OracleGrid>();
const oracleGridByUnderlyingCache = new Map<string, OracleGrid>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fieldName: string): string {
    if (isRecord(value) && "variant" in value) {
        return readString(value.variant, fieldName);
    }
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return value;
}

function readStringWithFallback(value: unknown, fieldName: string, fallback: string): string {
    try {
        return readString(value, fieldName);
    } catch {
        return fallback;
    }
}

function readStringOrNull(value: unknown, fieldName: string): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return null;
        }
        return readU64String(value[0], fieldName);
    }
    if (isRecord(value)) {
        if ("Some" in value) {
            return readU64String(value.Some, fieldName);
        }
        if ("some" in value) {
            return readU64String(value.some, fieldName);
        }
        if ("value" in value) {
            return readU64String(value.value, fieldName);
        }
        if ("fields" in value) {
            return readStringOrNull(value.fields, fieldName);
        }
        if ("vec" in value) {
            return readStringOrNull(value.vec, fieldName);
        }
        if ("None" in value || "none" in value) {
            return null;
        }
    }
    return readU64String(value, fieldName);
}

function describeRawShape(value: unknown): string {
    if (value === null) {
        return "null";
    }
    if (value === undefined) {
        return "undefined";
    }
    if (Array.isArray(value)) {
        return `array(length=${value.length})`;
    }
    if (isRecord(value)) {
        return `object(keys=${Object.keys(value).sort().join(",")})`;
    }
    return typeof value;
}

function readPositiveInteger(value: unknown, fieldName: string): number {
    const parsed = typeof value === "string" ? Number(value) : value;
    if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return parsed;
}

function readPositiveIntegerOrNull(value: unknown, fieldName: string): number | null {
    if (value === null || value === undefined) {
        return null;
    }
    return readPositiveInteger(value, fieldName);
}

function readU64String(value: unknown, fieldName: string): string {
    const text = typeof value === "number" ? String(value) : value;
    if (typeof text !== "string" || !/^(0|[1-9]\d*)$/.test(text)) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return text;
}

async function fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8_000);
    try {
        const response = await fetch(url, {
            headers: { accept: "application/json" },
            signal: controller.signal,
            cache: "no-store",
        });
        if (!response.ok) {
            throw new Error(`Predict server request failed: ${response.status}`);
        }
        return (await response.json()) as unknown;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function safeFetch<T>(read: () => Promise<T>): Promise<FetchResult<T>> {
    try {
        return { ok: true, value: await read() };
    } catch (caught) {
        return {
            ok: false,
            message: caught instanceof Error ? caught.message : String(caught),
            debug:
                caught instanceof OracleGridFetchError
                    ? caught.debug
                    : isRecord(caught) && "debug" in caught
                      ? caught.debug
                      : undefined,
        };
    }
}

async function fetchJsonRpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(PREDICT_BINARY_CONFIG.fullnodeJsonRpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        cache: "no-store",
    });
    if (!response.ok) {
        throw new Error(`Sui RPC request failed: ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    if (!isRecord(payload) || !("result" in payload)) {
        throw new Error("Invalid Sui RPC response");
    }
    return payload.result;
}

function parseOracle(value: unknown): OracleCandidate {
    if (!isRecord(value)) {
        throw new Error("Invalid oracle");
    }
    return {
        oracleId: readString(value.oracle_id, "oracle_id"),
        underlyingAsset: readString(value.underlying_asset, "underlying_asset"),
        lifecycle: readString(value.status, "status"),
        expiryMs: readPositiveInteger(value.expiry, "expiry"),
        activatedAtMs: readPositiveIntegerOrNull(value.activated_at, "activated_at"),
    };
}

function parsePrice(value: unknown): OraclePrice | null {
    if (!isRecord(value)) {
        return null;
    }
    try {
        return {
            spotRaw: readU64String(value.spot, "spot"),
            forwardRaw: readStringOrNull(value.forward, "forward"),
            onchainTimestampMs: readPositiveInteger(value.onchain_timestamp, "onchain_timestamp"),
        };
    } catch {
        return null;
    }
}

function readEventPayload(value: unknown): Record<string, unknown> | null {
    if (!isRecord(value)) {
        return null;
    }
    const payload = value.parsedJson ?? value.json ?? value.parsed_json;
    if (!isRecord(payload)) {
        return null;
    }
    if (isRecord(payload.fields)) {
        return payload.fields;
    }
    return payload;
}

function readFlexibleField(
    value: Record<string, unknown>,
    fieldNames: readonly string[],
): unknown {
    for (const fieldName of fieldNames) {
        if (fieldName in value) {
            return value[fieldName];
        }
    }
    return undefined;
}

function parseOracleIdField(value: unknown): string {
    if (isRecord(value)) {
        if ("id" in value) {
            return readString(value.id, "oracle_id.id");
        }
        if ("bytes" in value) {
            return readString(value.bytes, "oracle_id.bytes");
        }
        if ("fields" in value) {
            return parseOracleIdField(value.fields);
        }
    }
    return readString(value, "oracle_id");
}

function readFlexibleU64(value: unknown, fieldName: string): string {
    return readStringOrNull(value, fieldName) ?? readU64String(value, fieldName);
}

function parseOracleGridEventCore(value: unknown): Omit<OracleGrid, "source" | "debug"> | null {
    const payload = readEventPayload(value);
    if (!payload) {
        return null;
    }
    try {
        return {
            oracleId: parseOracleIdField(
                readFlexibleField(payload, ["oracle_id", "oracleId", "oracle"]),
            ),
            minStrikeRaw: readFlexibleU64(
                readFlexibleField(payload, [
                    "min_strike",
                    "minStrike",
                    "min_strike_raw",
                    "minStrikeRaw",
                ]),
                "min_strike",
            ),
            tickSizeRaw: readFlexibleU64(
                readFlexibleField(payload, [
                    "tick_size",
                    "tickSize",
                    "tick_size_raw",
                    "tickSizeRaw",
                ]),
                "tick_size",
            ),
        };
    } catch {
        return null;
    }
}

function parseOracleGridEvent(value: unknown): Omit<OracleGrid, "source" | "debug"> | null {
    return parseOracleGridEventCore(value);
}

function parseOracleGridEventOracleId(value: unknown): string | null {
    const payload = readEventPayload(value);
    if (!payload) {
        return null;
    }
    try {
        return parseOracleIdField(readFlexibleField(payload, ["oracle_id", "oracleId", "oracle"]));
    } catch {
        return null;
    }
}

function parseOracleGridEventUnderlyingAsset(value: unknown): string | null {
    const payload = readEventPayload(value);
    if (!payload) {
        return null;
    }
    try {
        return readString(
            readFlexibleField(payload, ["underlying_asset", "underlyingAsset"]),
            "underlying_asset",
        );
    } catch {
        return null;
    }
}

function parseOracleGridEventExpiryMs(value: unknown): number | null {
    const payload = readEventPayload(value);
    if (!payload) {
        return null;
    }
    try {
        return readPositiveInteger(readFlexibleField(payload, ["expiry", "expiryMs"]), "expiry");
    } catch {
        return null;
    }
}

function parseSettlementPriceFields(value: Record<string, unknown>): Pick<
    OracleState,
    | "settlementPriceRaw"
    | "settlementPriceParseError"
    | "rawSettlementPrice"
    | "rawSettlementPriceCamel"
    | "rawSettlementPriceRaw"
    | "rawSettlementPriceSnakeRaw"
> {
    if (!isRecord(value)) {
        throw new Error("Invalid oracle settlement fields");
    }
    const settlementCandidates = [
        ["settlement_price", value.settlement_price],
        ["settlementPrice", value.settlementPrice],
        ["settlementPriceRaw", value.settlementPriceRaw],
        ["settlement_price_raw", value.settlement_price_raw],
    ] as const;
    let settlementPriceRaw: string | null = null;
    let settlementPriceParseError: string | null = null;
    let sawSettlementField = false;
    for (const [fieldName, fieldValue] of settlementCandidates) {
        if (fieldValue === undefined || fieldValue === null) {
            continue;
        }
        sawSettlementField = true;
        try {
            settlementPriceRaw = readStringOrNull(fieldValue, fieldName);
            settlementPriceParseError = null;
            break;
        } catch (caught) {
            settlementPriceParseError = caught instanceof Error ? caught.message : String(caught);
        }
    }
    if (!sawSettlementField) {
        settlementPriceParseError = "No settlement price field present";
    }
    return {
        settlementPriceRaw,
        settlementPriceParseError,
        rawSettlementPrice: value.settlement_price,
        rawSettlementPriceCamel: value.settlementPrice,
        rawSettlementPriceRaw: value.settlementPriceRaw,
        rawSettlementPriceSnakeRaw: value.settlement_price_raw,
    };
}

function parseOracleState(value: unknown, source = "predict-server"): OracleState {
    if (!isRecord(value)) {
        throw new Error("Invalid oracle state");
    }
    const settlement = parseSettlementPriceFields(value);
    return {
        lifecycle: readString(value.status ?? value.lifecycle, "status"),
        ...settlement,
        source,
        rawState: value,
    };
}

function readRecordField(value: unknown, fieldName: string): unknown {
    return isRecord(value) ? value[fieldName] : undefined;
}

function parseOracleObjectState(value: unknown): OracleState {
    return parseOracleObjectStateWithFallback(value, "settled");
}

function parseOracleObjectStateWithFallback(value: unknown, fallbackLifecycle: string): OracleState {
    const data = readRecordField(value, "data");
    const content = readRecordField(data, "content");
    const fields = readRecordField(content, "fields");
    if (!isRecord(fields)) {
        throw new Error("Invalid oracle object fields");
    }
    const rawSettlementPricePathValue = fields.settlement_price;
    const settlement = parseSettlementPriceFields(fields);
    if (!settlement.settlementPriceRaw) {
        throw new Error(
            `Invalid content.fields.settlement_price: ${settlement.settlementPriceParseError}`,
        );
    }
    return {
        lifecycle: readStringWithFallback(
            fields.status ?? fields.lifecycle,
            "status",
            fallbackLifecycle,
        ),
        ...settlement,
        source: "sui-object",
        rawState: fields,
        rawSettlementPricePathValue,
    };
}

async function fetchBtcOracles(): Promise<OracleCandidate[]> {
    const value = await fetchJson(
        `${PREDICT_BINARY_CONFIG.predictServerUrl}/predicts/${PREDICT_BINARY_CONFIG.predictObjectId}/oracles`,
    );
    if (!Array.isArray(value)) {
        throw new Error("Invalid oracle list");
    }
    return value.map(parseOracle).sort((left, right) => left.expiryMs - right.expiryMs);
}

async function fetchOraclePrices(oracleId: string): Promise<OraclePrice[]> {
    const value = await fetchJson(
        `${PREDICT_BINARY_CONFIG.predictServerUrl}/oracles/${oracleId}/prices`,
    );
    if (!Array.isArray(value)) {
        throw new Error("Invalid oracle price history");
    }
    return value
        .map(parsePrice)
        .filter((price): price is OraclePrice => price !== null)
        .sort((left, right) => left.onchainTimestampMs - right.onchainTimestampMs);
}

async function fetchOracleState(oracleId: string): Promise<OracleState> {
    return parseOracleState(
        await fetchJson(`${PREDICT_BINARY_CONFIG.predictServerUrl}/oracles/${oracleId}/state`),
    );
}

async function fetchOracleObjectState(
    oracleId: string,
    fallbackLifecycle: string,
): Promise<OracleState> {
    return parseOracleObjectStateWithFallback(
        await fetchJsonRpc("sui_getObject", [
            oracleId,
            {
                showContent: true,
                showType: true,
            },
        ]),
        fallbackLifecycle,
    );
}

async function fetchOracleGrid(targetOracle: OracleCandidate): Promise<OracleGrid> {
    const oracleId = targetOracle.oracleId;
    const exactCache = oracleGridByOracleIdCache.get(oracleId);
    if (exactCache) {
        return exactCache;
    }
    const underlyingCache = oracleGridByUnderlyingCache.get(PREDICT_BINARY_CONFIG.underlyingAsset);
    if (underlyingCache) {
        const cachedFallback: OracleGrid = {
            ...underlyingCache,
            oracleId,
            source: "oracle_created_underlying_fallback",
            debug: {
                ...underlyingCache.debug,
                reason: "GRID_FROM_UNDERLYING_CACHE",
                targetOracleId: oracleId,
                gridSource: "oracle_created_underlying_fallback",
            },
        };
        oracleGridByOracleIdCache.set(oracleId, cachedFallback);
        return cachedFallback;
    }
    let cursor: unknown = null;
    let searchedEventCount = 0;
    let searchedPages = 0;
    let lastCursor: unknown = null;
    let matchedOracleCreatedEventFound = false;
    let matchedOracleId: string | null = null;
    let parsedFieldNames: string[] = [];
    let failureReason = "Oracle strike grid was not found";
    let fallbackCandidate:
        | {
              grid: Omit<OracleGrid, "source" | "debug">;
              underlyingAsset: string;
              expiryMs: number | null;
          }
        | null = null;
    let fallbackDistance: bigint | null = null;
    for (let page = 0; page < 20; page += 1) {
        const result = await fetchJsonRpc("suix_queryEvents", [
            {
                MoveEventType: `${PREDICT_BINARY_CONFIG.packageId}::registry::OracleCreated`,
            },
            cursor,
            50,
            true,
        ]);
        if (!isRecord(result) || !Array.isArray(result.data)) {
            throw new Error("Invalid OracleCreated event response");
        }
        searchedPages += 1;
        for (const item of result.data) {
            searchedEventCount += 1;
            const payload = readEventPayload(item);
            if (payload) {
                parsedFieldNames = Array.from(
                    new Set([...parsedFieldNames, ...Object.keys(payload)]),
                ).sort();
            }
            const eventOracleId = parseOracleGridEventOracleId(item);
            if (eventOracleId) {
                matchedOracleId = eventOracleId;
            }
            if (eventOracleId === oracleId) {
                matchedOracleCreatedEventFound = true;
            }
            const underlyingAsset = parseOracleGridEventUnderlyingAsset(item);
            const expiryMs = parseOracleGridEventExpiryMs(item);
            const grid = parseOracleGridEvent(item);
            if (!grid) {
                if (eventOracleId === oracleId) {
                    failureReason =
                        "Matching OracleCreated event was found but min_strike/tick_size could not be parsed";
                }
                continue;
            }
            if (grid.oracleId === oracleId) {
                matchedOracleId = grid.oracleId;
                const debug: OracleGridSearchDebug = {
                    reason: "GRID_FROM_EXACT_ORACLE_CREATED_EVENT",
                    targetOracleId: oracleId,
                    searchedEventCount,
                    searchedPages,
                    lastCursor,
                    matchedOracleCreatedEventFound: true,
                    matchedOracleId: grid.oracleId,
                    exactMatchFound: true,
                    fallbackCandidateFound: Boolean(fallbackCandidate),
                    fallbackReason: undefined,
                    lastSeenOracleId: grid.oracleId,
                    parsedFieldNames,
                    gridSource: "oracle_created_exact",
                    minStrikeRaw: grid.minStrikeRaw,
                    tickSizeRaw: grid.tickSizeRaw,
                };
                const exactGrid: OracleGrid = {
                    ...grid,
                    source: "oracle_created_exact",
                    debug,
                };
                oracleGridByOracleIdCache.set(oracleId, exactGrid);
                return exactGrid;
            }
            matchedOracleId = grid.oracleId;
            if (underlyingAsset === PREDICT_BINARY_CONFIG.underlyingAsset) {
                const distance =
                    expiryMs === null
                        ? null
                        : BigInt(Math.abs(expiryMs - targetOracle.expiryMs));
                if (
                    !fallbackCandidate ||
                    fallbackDistance === null ||
                    (distance !== null && distance < fallbackDistance)
                ) {
                    fallbackCandidate = { grid, underlyingAsset, expiryMs };
                    fallbackDistance = distance;
                }
            }
        }
        if (result.hasNextPage !== true) {
            failureReason = "OracleCreated event pagination ended before target oracle was found";
            break;
        }
        cursor = result.nextCursor;
        lastCursor = cursor;
    }
    if (fallbackCandidate) {
        const debug: OracleGridSearchDebug = {
            reason: "GRID_FROM_UNDERLYING_FALLBACK",
            targetOracleId: oracleId,
            searchedEventCount,
            searchedPages,
            lastCursor,
            matchedOracleCreatedEventFound,
            matchedOracleId,
            exactMatchFound: false,
            fallbackCandidateFound: true,
            fallbackReason:
                "Exact OracleCreated event was not found in the searched window; using BTC underlying grid fallback",
            fallbackOracleId: fallbackCandidate.grid.oracleId,
            fallbackExpiry: fallbackCandidate.expiryMs ?? undefined,
            fallbackUnderlyingAsset: fallbackCandidate.underlyingAsset,
            lastSeenOracleId: matchedOracleId,
            parsedFieldNames,
            gridSource: "oracle_created_underlying_fallback",
            minStrikeRaw: fallbackCandidate.grid.minStrikeRaw,
            tickSizeRaw: fallbackCandidate.grid.tickSizeRaw,
        };
        const fallbackGrid: OracleGrid = {
            oracleId,
            minStrikeRaw: fallbackCandidate.grid.minStrikeRaw,
            tickSizeRaw: fallbackCandidate.grid.tickSizeRaw,
            source: "oracle_created_underlying_fallback",
            fallbackOracleId: fallbackCandidate.grid.oracleId,
            fallbackExpiryMs: fallbackCandidate.expiryMs ?? undefined,
            fallbackUnderlyingAsset: fallbackCandidate.underlyingAsset,
            debug,
        };
        oracleGridByOracleIdCache.set(oracleId, fallbackGrid);
        oracleGridByUnderlyingCache.set(PREDICT_BINARY_CONFIG.underlyingAsset, fallbackGrid);
        return fallbackGrid;
    }
    throw new OracleGridFetchError(failureReason, {
        reason: failureReason,
        targetOracleId: oracleId,
        searchedEventCount,
        searchedPages,
        lastCursor,
        matchedOracleCreatedEventFound,
        matchedOracleId,
        exactMatchFound: false,
        fallbackCandidateFound: false,
        fallbackReason: "No BTC OracleCreated event with parseable min_strike/tick_size was found",
        lastSeenOracleId: matchedOracleId,
        parsedFieldNames,
    });
}

function toSummary(oracle: OracleCandidate | null): OracleSummary | null {
    return oracle ? { oracleId: oracle.oracleId, expiryMs: oracle.expiryMs } : null;
}

function toPreviousOracleResponse(
    oracle: OracleCandidate | null,
    state: OracleState | null,
): PreviousOracleResponse | null {
    if (!oracle) {
        return null;
    }
    return {
        oracleId: oracle.oracleId,
        expiryMs: oracle.expiryMs,
        lifecycle: state?.lifecycle ?? oracle.lifecycle,
        settlementPriceRaw: state?.settlementPriceRaw ?? null,
    };
}

function toCurrentOracleResponse(
    oracle: OracleCandidate,
    grid: OracleGrid | null,
    latestPrice: OraclePrice | null,
): CurrentOracleResponse {
    return {
        oracleId: oracle.oracleId,
        lifecycle: oracle.lifecycle,
        expiryMs: oracle.expiryMs,
        spotRaw: latestPrice?.spotRaw ?? null,
        forwardRaw: latestPrice?.forwardRaw ?? null,
        timestampMs: latestPrice?.onchainTimestampMs ?? null,
        minStrikeRaw: grid?.minStrikeRaw ?? null,
        tickSizeRaw: grid?.tickSizeRaw ?? null,
    };
}

function emptyResponse(
    state: PredictRoundStatus,
    message?: string,
    debug?: MarketResponse["debug"],
): MarketResponse {
    return {
        state,
        currentOracle: null,
        previousOracle: null,
        nextOracle: null,
        round: null,
        message,
        debug,
    };
}

function roundDataErrorResponse({
    currentOracle,
    previousOracle,
    nextOracle,
    grid,
    latestPrice,
    previousOracleState,
    reason,
    originalErrorMessage,
    debug,
}: {
    currentOracle: OracleCandidate;
    previousOracle: OracleCandidate | null;
    nextOracle: OracleCandidate | null;
    grid: OracleGrid | null;
    latestPrice: OraclePrice | null;
    previousOracleState: OracleState | null;
    reason: string;
    originalErrorMessage?: string;
    debug?: Partial<NonNullable<MarketResponse["debug"]>>;
}): MarketResponse {
    return {
        state: "ROUND_DATA_ERROR",
        currentOracle: toCurrentOracleResponse(currentOracle, grid, latestPrice),
        previousOracle: toPreviousOracleResponse(previousOracle, previousOracleState),
        nextOracle: toSummary(nextOracle),
        round: null,
        message: "Failed to build round data",
        debug: { ...debug, reason, originalErrorMessage },
    };
}

function previousOracleStateDebug(state: OracleState | null): NonNullable<MarketResponse["debug"]> {
    if (!state) {
        return { reason: "PREVIOUS_ORACLE_STATE_UNAVAILABLE" };
    }
    return {
        reason: state.settlementPriceParseError ?? "PREVIOUS_ORACLE_SETTLEMENT_PRICE_UNAVAILABLE",
        originalErrorMessage: JSON.stringify({
            lifecycle: state.lifecycle,
            rawSettlementPrice: state.rawSettlementPrice,
            rawSettlementPriceCamel: state.rawSettlementPriceCamel,
            rawSettlementPriceRaw: state.rawSettlementPriceRaw,
            rawSettlementPriceSnakeRaw: state.rawSettlementPriceSnakeRaw,
            rawSettlementPricePathValue: state.rawSettlementPricePathValue,
            settlementPriceRaw: state.settlementPriceRaw,
            settlementPriceParseError: state.settlementPriceParseError,
            source: state.source,
        }),
        settlementPriceRawShape: describeRawShape(state.rawSettlementPrice),
        settlementPriceParseError: state.settlementPriceParseError,
        rawSettlementPricePathValue: state.rawSettlementPricePathValue,
        rawSettlementPriceType: typeof state.rawSettlementPricePathValue,
        parseFailureReason: state.settlementPriceParseError,
    };
}

export async function GET(): Promise<NextResponse<MarketResponse>> {
    let currentOracleForLog: OracleCandidate | null = null;
    let previousOracleForLog: OracleCandidate | null = null;
    try {
        const nowMs = Date.now();
        const oraclesResult = await safeFetch(fetchBtcOracles);
        if (!oraclesResult.ok) {
            return NextResponse.json(
                emptyResponse("ROUND_DATA_ERROR", "Failed to fetch BTC oracle list", {
                    reason: "ORACLE_LIST_FETCH_FAILED",
                    originalErrorMessage: oraclesResult.message,
                }),
            );
        }
        const oracles = oraclesResult.value;
        const { currentOracle, previousOracle, nextOracle } = selectCurrentBtcOracle(oracles, nowMs);
        currentOracleForLog = currentOracle;
        previousOracleForLog = previousOracle;

        if (!currentOracle) {
            return NextResponse.json(
                emptyResponse("NO_ACTIVE_ROUND", "No active BTC oracle found"),
            );
        }

        if (!previousOracle) {
            return NextResponse.json(
                emptyResponse("NO_ACTIVE_ROUND", "Previous BTC oracle was not found"),
            );
        }

        const [
            gridResult,
            pricesResult,
            previousOracleStateResult,
            previousOracleObjectStateResult,
        ] = await Promise.all([
            safeFetch(() => fetchOracleGrid(currentOracle)),
            safeFetch(() => fetchOraclePrices(currentOracle.oracleId)),
            safeFetch(() => fetchOracleState(previousOracle.oracleId)),
            safeFetch(() => fetchOracleObjectState(previousOracle.oracleId, previousOracle.lifecycle)),
        ]);
        const grid = gridResult.ok ? gridResult.value : null;
        const prices = pricesResult.ok ? pricesResult.value : null;
        const latestPrice = prices?.at(-1) ?? null;
        const predictServerPreviousOracleState = previousOracleStateResult.ok
            ? previousOracleStateResult.value
            : null;
        const objectPreviousOracleState = previousOracleObjectStateResult.ok
            ? previousOracleObjectStateResult.value
            : null;
        const previousOracleState =
            predictServerPreviousOracleState?.settlementPriceRaw
                ? predictServerPreviousOracleState
                : objectPreviousOracleState?.settlementPriceRaw
                  ? objectPreviousOracleState
                  : (predictServerPreviousOracleState ?? objectPreviousOracleState);
        if (process.env.NODE_ENV !== "production") {
            console.info("Predict BTC previous oracle raw state", {
                currentOracleId: currentOracle.oracleId,
                currentOracleExpiryMs: currentOracle.expiryMs,
                previousOracleId: previousOracle.oracleId,
                previousOracleExpiryMs: previousOracle.expiryMs,
                previousOracleStateFetchOk: previousOracleStateResult.ok,
                previousOracleStateFetchError: previousOracleStateResult.ok
                    ? null
                    : previousOracleStateResult.message,
                previousOracleObjectFetchOk: previousOracleObjectStateResult.ok,
                previousOracleObjectFetchError: previousOracleObjectStateResult.ok
                    ? null
                    : previousOracleObjectStateResult.message,
                suiGetObjectCalled: true,
                suiGetObjectMethod: "sui_getObject",
                selectedPreviousOracleStateSource: previousOracleState?.source ?? null,
                rawState: previousOracleState?.rawState ?? null,
                rawSettlementPrice: previousOracleState?.rawSettlementPrice,
                rawSettlementPricePathValue: previousOracleState?.rawSettlementPricePathValue,
                rawSettlementPriceShape: describeRawShape(previousOracleState?.rawSettlementPrice),
                rawSettlementPriceCamel: previousOracleState?.rawSettlementPriceCamel,
                rawSettlementPriceRaw: previousOracleState?.rawSettlementPriceRaw,
                rawSettlementPriceSnakeRaw: previousOracleState?.rawSettlementPriceSnakeRaw,
                settlementPriceRaw: previousOracleState?.settlementPriceRaw ?? null,
                settlementPriceParseError: previousOracleState?.settlementPriceParseError ?? null,
            });
        }
        const roundOpenMs = calculateRoundOpen({
            previousExpiryMs: previousOracle?.expiryMs ?? null,
            activatedAtMs: null,
        });
        if (roundOpenMs === null) {
            return NextResponse.json(
                roundDataErrorResponse({
                    currentOracle,
                    previousOracle,
                    nextOracle,
                    grid,
                    latestPrice,
                    previousOracleState,
                    reason: "ROUND_OPEN_NOT_FOUND",
                }),
            );
        }

        const bettingCloseMs = calculateBettingClose(currentOracle.expiryMs);
        const currentOracleResponse = toCurrentOracleResponse(currentOracle, grid, latestPrice);
        const previousOracleResponse = toPreviousOracleResponse(previousOracle, previousOracleState);

        if (!latestPrice) {
            return NextResponse.json(
                roundDataErrorResponse({
                    currentOracle,
                    previousOracle,
                    nextOracle,
                    grid,
                    latestPrice,
                    previousOracleState,
                    reason: "CURRENT_PRICE_UNAVAILABLE",
                    originalErrorMessage: pricesResult.ok ? undefined : pricesResult.message,
                }),
            );
        }
        if (!grid) {
            const gridDebug = !gridResult.ok && isRecord(gridResult.debug) ? gridResult.debug : {};
            return NextResponse.json(
                roundDataErrorResponse({
                    currentOracle,
                    previousOracle,
                    nextOracle,
                    grid,
                    latestPrice,
                    previousOracleState,
                    reason: "STRIKE_GRID_UNAVAILABLE",
                    originalErrorMessage: gridResult.ok ? undefined : gridResult.message,
                    debug: {
                        searchedEventCount:
                            typeof gridDebug.searchedEventCount === "number"
                                ? gridDebug.searchedEventCount
                                : undefined,
                        searchedPages:
                            typeof gridDebug.searchedPages === "number"
                                ? gridDebug.searchedPages
                                : undefined,
                        targetOracleId:
                            typeof gridDebug.targetOracleId === "string"
                                ? gridDebug.targetOracleId
                                : currentOracle.oracleId,
                        lastCursor: gridDebug.lastCursor,
                        matchedOracleCreatedEventFound:
                            typeof gridDebug.matchedOracleCreatedEventFound === "boolean"
                                ? gridDebug.matchedOracleCreatedEventFound
                                : undefined,
                        matchedOracleId:
                            typeof gridDebug.matchedOracleId === "string"
                                ? gridDebug.matchedOracleId
                                : null,
                        exactMatchFound:
                            typeof gridDebug.exactMatchFound === "boolean"
                                ? gridDebug.exactMatchFound
                                : undefined,
                        fallbackCandidateFound:
                            typeof gridDebug.fallbackCandidateFound === "boolean"
                                ? gridDebug.fallbackCandidateFound
                                : undefined,
                        fallbackReason:
                            typeof gridDebug.fallbackReason === "string"
                                ? gridDebug.fallbackReason
                                : undefined,
                        fallbackOracleId:
                            typeof gridDebug.fallbackOracleId === "string"
                                ? gridDebug.fallbackOracleId
                                : undefined,
                        fallbackExpiry:
                            typeof gridDebug.fallbackExpiry === "number"
                                ? gridDebug.fallbackExpiry
                                : undefined,
                        fallbackUnderlyingAsset:
                            typeof gridDebug.fallbackUnderlyingAsset === "string"
                                ? gridDebug.fallbackUnderlyingAsset
                                : undefined,
                        lastSeenOracleId:
                            typeof gridDebug.lastSeenOracleId === "string"
                                ? gridDebug.lastSeenOracleId
                                : null,
                        parsedFieldNames: Array.isArray(gridDebug.parsedFieldNames)
                            ? gridDebug.parsedFieldNames.filter(
                                  (fieldName: unknown): fieldName is string =>
                                      typeof fieldName === "string",
                              )
                            : undefined,
                        gridFailureReason:
                            typeof gridDebug.reason === "string" ? gridDebug.reason : undefined,
                        gridSource:
                            typeof gridDebug.gridSource === "string"
                                ? gridDebug.gridSource
                                : undefined,
                    },
                }),
                {
                    status: 200,
                },
            );
        }
        if (!previousOracleState) {
            return NextResponse.json({
                state: "LOCKING_ROUND",
                currentOracle: currentOracleResponse,
                previousOracle: previousOracleResponse,
                nextOracle: toSummary(nextOracle),
                round: null,
                message: "Previous oracle state is not available yet",
                debug: {
                    reason: "PREVIOUS_ORACLE_STATE_UNAVAILABLE",
                    originalErrorMessage: previousOracleStateResult.ok
                        ? undefined
                        : previousOracleStateResult.message,
                    previousOracleStateFetchError: previousOracleStateResult.ok
                        ? undefined
                        : previousOracleStateResult.message,
                    previousOracleObjectFetchError: previousOracleObjectStateResult.ok
                        ? undefined
                        : previousOracleObjectStateResult.message,
                    suiGetObjectCalled: true,
                    suiGetObjectMethod: "sui_getObject",
                    previousOracleObjectId: previousOracle.oracleId,
                    rawSettlementPricePathValue:
                        objectPreviousOracleState?.rawSettlementPricePathValue,
                    rawSettlementPriceType:
                        typeof objectPreviousOracleState?.rawSettlementPricePathValue,
                    parseFailureReason: previousOracleObjectStateResult.ok
                        ? (objectPreviousOracleState?.settlementPriceParseError ?? null)
                        : previousOracleObjectStateResult.message,
                },
            });
        }
        if (!previousOracleState.settlementPriceRaw) {
            return NextResponse.json({
                state: "LOCKING_ROUND",
                currentOracle: currentOracleResponse,
                previousOracle: previousOracleResponse,
                nextOracle: toSummary(nextOracle),
                round: null,
                message: "Previous oracle settlement price is not available yet",
                debug: {
                    ...previousOracleStateDebug(previousOracleState),
                    previousOracleStateSource: previousOracleState.source,
                    previousOracleStateFetchError: previousOracleStateResult.ok
                        ? undefined
                        : previousOracleStateResult.message,
                    previousOracleObjectFetchError: previousOracleObjectStateResult.ok
                        ? undefined
                        : previousOracleObjectStateResult.message,
                    suiGetObjectCalled: true,
                    suiGetObjectMethod: "sui_getObject",
                    previousOracleObjectId: previousOracle.oracleId,
                },
            });
        }

        let roundLock: ReturnType<typeof buildSettlementRoundLock>;
        try {
            roundLock = buildSettlementRoundLock({
                currentOracleId: currentOracle.oracleId,
                previousOracleId: previousOracle.oracleId,
                previousExpiryMs: previousOracle.expiryMs,
                openingSpotRaw: previousOracleState.settlementPriceRaw,
                grid: {
                    minStrike: BigInt(grid.minStrikeRaw),
                    tickSize: BigInt(grid.tickSizeRaw),
                },
            });
        } catch (caught) {
            return NextResponse.json(
                roundDataErrorResponse({
                    currentOracle,
                    previousOracle,
                    nextOracle,
                    grid,
                    latestPrice,
                    previousOracleState,
                    reason: "ROUND_LOCK_BUILD_FAILED",
                    originalErrorMessage:
                        caught instanceof Error ? caught.message : String(caught),
                }),
            );
        }

        const state = getRoundStatus({
            nowMs,
            bettingCloseMs,
            expiryMs: currentOracle.expiryMs,
            hasOpeningSpot: true,
            oracleLifecycle: currentOracle.lifecycle,
        });

        if (process.env.NODE_ENV !== "production") {
                console.info("Predict BTC round lock", {
                    oracleId: currentOracle.oracleId,
                    expiryMs: currentOracle.expiryMs,
                    gridSource: grid.source,
                    fallbackOracleId: grid.fallbackOracleId ?? null,
                    fallbackExpiryMs: grid.fallbackExpiryMs ?? null,
                    fallbackUnderlyingAsset: grid.fallbackUnderlyingAsset ?? null,
                    roundOpenMs,
                    previousOracleId: previousOracle?.oracleId ?? null,
                    previousOracleExpiryMs: previousOracle?.expiryMs ?? null,
                previousOracleLifecycle: previousOracleState.lifecycle,
                previousOracleSettlementPriceRaw: previousOracleState.settlementPriceRaw,
                priceHistoryCount: prices?.length ?? 0,
                priceHistoryFirstTimestampMs: prices?.[0]?.onchainTimestampMs ?? null,
                priceHistoryLastTimestampMs: latestPrice.onchainTimestampMs,
                openingSpotRaw: roundLock.openingSpotRaw,
                minStrikeRaw: grid.minStrikeRaw,
                tickSizeRaw: grid.tickSizeRaw,
                binaryStrikeRaw: roundLock.binaryStrikeRaw,
                roundId: roundLock.roundId,
            });
        }

        return NextResponse.json({
            state,
            currentOracle: currentOracleResponse,
            previousOracle: previousOracleResponse,
            nextOracle: toSummary(nextOracle),
            round: {
                roundId: roundLock.roundId,
                currentOracleId: currentOracle.oracleId,
                previousOracleId: previousOracle.oracleId,
                roundOpenMs: roundLock.roundOpenMs,
                bettingCloseMs,
                expiryMs: currentOracle.expiryMs,
                openingSpotRaw: roundLock.openingSpotRaw,
                binaryStrikeRaw: roundLock.binaryStrikeRaw,
                minStrikeRaw: grid.minStrikeRaw,
                tickSizeRaw: grid.tickSizeRaw,
                state,
            },
            debug: {
                reason: "ROUND_READY",
                gridSource: grid.source,
                targetOracleId: currentOracle.oracleId,
                exactMatchFound: grid.source === "oracle_created_exact",
                fallbackCandidateFound: grid.source === "oracle_created_underlying_fallback",
                fallbackReason:
                    grid.source === "oracle_created_underlying_fallback"
                        ? grid.debug.fallbackReason
                        : undefined,
                fallbackOracleId: grid.fallbackOracleId,
                fallbackExpiry: grid.fallbackExpiryMs,
                fallbackUnderlyingAsset: grid.fallbackUnderlyingAsset,
                searchedEventCount: grid.debug.searchedEventCount,
                searchedPages: grid.debug.searchedPages,
                matchedOracleCreatedEventFound: grid.debug.matchedOracleCreatedEventFound,
                matchedOracleId: grid.debug.matchedOracleId,
                lastSeenOracleId: grid.debug.lastSeenOracleId,
                parsedFieldNames: grid.debug.parsedFieldNames,
                minStrikeRaw: grid.minStrikeRaw,
                tickSizeRaw: grid.tickSizeRaw,
                previousOracleStateSource: previousOracleState.source,
                previousOracleStateFetchError: previousOracleStateResult.ok
                    ? undefined
                    : previousOracleStateResult.message,
                previousOracleObjectFetchError: previousOracleObjectStateResult.ok
                    ? undefined
                    : previousOracleObjectStateResult.message,
                settlementPriceRawShape: describeRawShape(previousOracleState.rawSettlementPrice),
                settlementPriceParseError: previousOracleState.settlementPriceParseError,
                suiGetObjectCalled: true,
                suiGetObjectMethod: "sui_getObject",
                previousOracleObjectId: previousOracle.oracleId,
                rawSettlementPricePathValue: previousOracleState.rawSettlementPricePathValue,
                rawSettlementPriceType: typeof previousOracleState.rawSettlementPricePathValue,
                parseFailureReason: previousOracleState.settlementPriceParseError,
            },
        });
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Round fetch failed";
        console.error("btc-market route fatal error", {
            name: caught instanceof Error ? caught.name : "UnknownError",
            message,
            stack: caught instanceof Error ? caught.stack : undefined,
            currentOracleId: currentOracleForLog?.oracleId ?? null,
            previousOracleId: previousOracleForLog?.oracleId ?? null,
            expiryMs: currentOracleForLog?.expiryMs ?? null,
        });
        return NextResponse.json(emptyResponse("ERROR", message), { status: 502 });
    }
}
