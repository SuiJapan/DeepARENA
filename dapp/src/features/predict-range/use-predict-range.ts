"use client";

import {
    useCurrentAccount,
    useCurrentClient,
    useCurrentNetwork,
    useDAppKit,
} from "@mysten/dapp-kit-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PredictRoundMarket } from "@/src/features/predict-round/use-predict-round";
import { requestBalanceRefresh } from "@/src/lib/balance-refresh";
import { formatTokenAmount, parseTokenAmount } from "@/src/lib/plp-sandbox/amounts";
import {
    checkArenaPlayerJoined,
    findPredictManager,
    type MintedPositionEvent,
    POSITION_MINTED_EVENT_TYPE,
    readDigest,
    readManagerCreatedEvent,
    readPositionMintedEvent,
    readRangeMintedEvent,
} from "@/src/lib/predict-binary/client";
import { PREDICT_BINARY_CONFIG } from "@/src/lib/predict-binary/config";
import { formatBinaryOddsFromQuantity } from "@/src/lib/predict-binary/odds";
import {
    calcMaxTotalCost,
    createJoinArenaTransaction,
    createMintBreakTransaction,
    createMintRangeTransaction,
    createPredictManagerTransaction,
    describeCreatePredictManagerMoveCalls,
    describeMintBreakMoveCalls,
    describeMintRangeMoveCalls,
} from "@/src/lib/predict-binary/transactions";
import { GRID_TICKS } from "@/src/lib/predict-round/round";
import {
    isWalletUserRejection,
    readWalletCancellationDebug,
    readWalletErrorMessage,
} from "@/src/lib/wallet-errors";

export type RangeDirection = "RANGE" | "BREAK";
export type RangePreviewStatus = "IDLE" | "PREVIEWING" | "READY" | "ERROR";
export type RangeTxStatus = "READY" | "CONFIRM IN WALLET" | "SUBMITTING" | "PLACED" | "FAILED";

interface RangeMarket {
    oracleId: string;
    expiryMs: number;
    referenceStrike: bigint;
    lowerStrike: bigint;
    higherStrike: bigint;
    widthTicks: bigint;
    oracleTimestampMs: number | null;
}

interface RangeBaseMarket {
    oracleId: string;
    expiryMs: number;
    referenceStrike: bigint;
    minStrike: bigint;
    maxStrike: bigint;
    tickSize: bigint;
    oracleTimestampMs: number | null;
}

interface RangePreview {
    kind: "RANGE";
    quantity: bigint;
    mintCost: bigint;
    redeemPayout: bigint;
    liveOdds: string;
}

interface BreakLegPreview {
    quantity: bigint;
    mintCost: bigint;
    payout: bigint;
    liveOdds: string;
}

interface BreakPreview {
    kind: "BREAK";
    mintCost: bigint;
    effectivePayout: bigint;
    liveOdds: string;
    lowerLeg: BreakLegPreview;
    upperLeg: BreakLegPreview;
}

type GamePreview = RangePreview | BreakPreview;

interface RangePreviewState {
    status: RangePreviewStatus;
    selected: SelectedRangeCandidate | null;
    error: string | null;
}

interface SelectedRangeCandidate {
    market: RangeMarket;
    rangePreview: RangePreview | null;
    rangePreviewKey: string | null;
    breakPreview: BreakPreview | null;
    breakPreviewKey: string | null;
}

interface RangePreviewApiSuccess {
    ok: true;
    direction: "RANGE";
    previewKey: string;
    quantity: string;
    mintCost: string;
    redeemPayout: string;
    liveOdds: string;
}

interface BreakLegPreviewApi {
    quantity: string;
    mintCost: string;
    payout: string;
    liveOdds: string;
}

interface BreakPreviewApiSuccess {
    ok: true;
    direction: "BREAK";
    previewKey: string;
    mintCost: string;
    effectivePayout: string;
    liveOdds: string;
    lowerLeg: BreakLegPreviewApi;
    upperLeg: BreakLegPreviewApi;
}

interface RangePreviewApiFailure {
    ok: false;
    direction: "RANGE" | "BREAK";
    previewKey: string;
    error: string;
    reason: string;
}

type RangePreviewApiResponse =
    | RangePreviewApiSuccess
    | BreakPreviewApiSuccess
    | RangePreviewApiFailure;

const FIXED_RANGE_WIDTH_TICKS = 1000n;
const RANGE_PREVIEW_COOLDOWN_MS = 30_000;

interface CachedRangePreview {
    preview: RangePreview;
    previewKey: string;
}

type DirectionPreviewResult =
    | { ok: true; preview: RangePreview; previewKey: string; fromCache: boolean }
    | { ok: false; reason: string; fromCache: boolean };

const successfulRangePreviewByKey = new Map<string, CachedRangePreview>();
const inFlightRangePreviewByKey = new Map<string, Promise<DirectionPreviewResult>>();
const rangePreviewCooldownByKey = new Map<string, number>();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTransactionEvents(value: unknown): unknown[] {
    if (isRecord(value) && Array.isArray(value.events)) {
        return value.events;
    }
    const transaction = isRecord(value) ? value.Transaction : null;
    return isRecord(transaction) && Array.isArray(transaction.events) ? transaction.events : [];
}

function rangeBaseMarketFromRound(roundMarket: PredictRoundMarket | null): RangeBaseMarket | null {
    const round = roundMarket?.round;
    const currentOracle = roundMarket?.currentOracle;
    if (!round || !currentOracle) {
        return null;
    }
    const tickSize = BigInt(round.tickSizeRaw);
    const center = BigInt(round.binaryStrikeRaw);
    const minStrike = BigInt(round.minStrikeRaw);
    if (tickSize <= 0n || center <= tickSize || minStrike <= 0n) {
        return null;
    }
    return {
        oracleId: currentOracle.oracleId,
        expiryMs: currentOracle.expiryMs,
        referenceStrike: center,
        minStrike,
        maxStrike: minStrike + tickSize * GRID_TICKS,
        tickSize,
        oracleTimestampMs: currentOracle.timestampMs,
    };
}

function rangeMarketFromBase(base: RangeBaseMarket | null): RangeMarket | null {
    if (!base) {
        return null;
    }
    const widthRaw = base.tickSize * FIXED_RANGE_WIDTH_TICKS;
    if (base.referenceStrike <= widthRaw) {
        return null;
    }
    const lowerStrike = base.referenceStrike - widthRaw;
    const higherStrike = base.referenceStrike + widthRaw;
    if (
        lowerStrike >= higherStrike ||
        lowerStrike < base.minStrike ||
        higherStrike > base.maxStrike ||
        (lowerStrike - base.minStrike) % base.tickSize !== 0n ||
        (higherStrike - base.minStrike) % base.tickSize !== 0n
    ) {
        return null;
    }
    return {
        oracleId: base.oracleId,
        expiryMs: base.expiryMs,
        referenceStrike: base.referenceStrike,
        lowerStrike,
        higherStrike,
        widthTicks: FIXED_RANGE_WIDTH_TICKS,
        oracleTimestampMs: base.oracleTimestampMs,
    };
}

function buildPreviewKey({
    direction,
    address,
    market,
    budget,
}: {
    direction: RangeDirection;
    address: string;
    market: RangeMarket;
    budget: bigint;
}): string {
    return [
        direction,
        address,
        market.oracleId,
        market.expiryMs.toString(),
        market.referenceStrike.toString(),
        market.lowerStrike.toString(),
        market.higherStrike.toString(),
        market.widthTicks.toString(),
        budget.toString(),
    ].join(":");
}

function buildDisplayPreviewKey({
    address,
    market,
    budget,
}: {
    address: string;
    market: RangeMarket;
    budget: bigint;
}): string {
    return [
        address,
        market.oracleId,
        market.expiryMs.toString(),
        market.referenceStrike.toString(),
        market.lowerStrike.toString(),
        market.higherStrike.toString(),
        market.widthTicks.toString(),
        budget.toString(),
    ].join(":");
}

function emptyPreview(status: RangePreviewStatus): RangePreviewState {
    return { status, selected: null, error: null };
}

function isRateLimitPreviewReason(reason: string): boolean {
    return reason.includes("429") || reason.toLowerCase().includes("rate limit");
}

function userFacingPreviewReason(reason: string): string {
    return isRateLimitPreviewReason(reason) ? "Preview temporarily unavailable" : reason;
}

function userFacingAggregatePreviewReason(reason: string | null): string | null {
    if (!reason) {
        return null;
    }
    if (isRateLimitPreviewReason(reason) || reason.includes("Preview temporarily unavailable")) {
        return "Preview temporarily unavailable";
    }
    return reason;
}

function readDirectionPreviewFailureReason(result: DirectionPreviewResult): string | null {
    if (result.ok) {
        return null;
    }
    return result.reason;
}

function formatRawPrice(raw: bigint): string {
    const whole = raw / PREDICT_BINARY_CONFIG.priceScale;
    const fractional = raw % PREDICT_BINARY_CONFIG.priceScale;
    const value = Number(whole) + Number(fractional) / Number(PREDICT_BINARY_CONFIG.priceScale);
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
    }).format(value);
}

function formatRawPriceDelta(raw: bigint): string {
    const whole = raw / PREDICT_BINARY_CONFIG.priceScale;
    const fractional = raw % PREDICT_BINARY_CONFIG.priceScale;
    const value = Number(whole) + Number(fractional) / Number(PREDICT_BINARY_CONFIG.priceScale);
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
    }).format(value);
}

async function fetchRangePreview({
    direction,
    address,
    market,
    budget,
}: {
    direction: RangeDirection;
    address: string;
    market: RangeMarket;
    budget: bigint;
}): Promise<RangePreviewApiResponse> {
    const response = await fetch("/api/predict/range-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            direction,
            walletAddress: address,
            betAmountAtomic: budget.toString(),
            oracleId: market.oracleId,
            expiryMs: market.expiryMs.toString(),
            referenceStrikeRaw: market.referenceStrike.toString(),
            lowerStrikeRaw: market.lowerStrike.toString(),
            higherStrikeRaw: market.higherStrike.toString(),
            widthTicks: market.widthTicks.toString(),
            oracleTimestampMs: String(market.oracleTimestampMs ?? 0),
            predictObjectId: PREDICT_BINARY_CONFIG.predictObjectId,
            quoteCoinType: PREDICT_BINARY_CONFIG.quoteCoinType,
        }),
    });
    const body = (await response.json()) as unknown;
    if (!isRecord(body) || typeof body.previewKey !== "string" || typeof body.ok !== "boolean") {
        throw new Error("Invalid range preview response");
    }
    if (!body.ok) {
        return {
            ok: false,
            direction:
                body.direction === "RANGE" || body.direction === "BREAK"
                    ? body.direction
                    : direction,
            previewKey: body.previewKey,
            error: typeof body.error === "string" ? body.error : "Preview failed",
            reason: typeof body.reason === "string" ? body.reason : "PREVIEW_FAILED",
        };
    }
    if (body.direction === "BREAK") {
        return {
            ok: true,
            direction: "BREAK",
            previewKey: body.previewKey,
            mintCost: typeof body.mintCost === "string" ? body.mintCost : "0",
            effectivePayout: typeof body.effectivePayout === "string" ? body.effectivePayout : "0",
            liveOdds: typeof body.liveOdds === "string" ? body.liveOdds : "--",
            lowerLeg: readBreakLegPreview(body.lowerLeg),
            upperLeg: readBreakLegPreview(body.upperLeg),
        };
    }
    return {
        ok: true,
        direction: "RANGE",
        previewKey: body.previewKey,
        quantity: typeof body.quantity === "string" ? body.quantity : "0",
        mintCost: typeof body.mintCost === "string" ? body.mintCost : "0",
        redeemPayout: typeof body.redeemPayout === "string" ? body.redeemPayout : "0",
        liveOdds: typeof body.liveOdds === "string" ? body.liveOdds : "--",
    };
}

function readBreakLegPreview(value: unknown): BreakLegPreviewApi {
    if (!isRecord(value)) {
        return { quantity: "0", mintCost: "0", payout: "0", liveOdds: "--" };
    }
    return {
        quantity: typeof value.quantity === "string" ? value.quantity : "0",
        mintCost: typeof value.mintCost === "string" ? value.mintCost : "0",
        payout: typeof value.payout === "string" ? value.payout : "0",
        liveOdds: typeof value.liveOdds === "string" ? value.liveOdds : "--",
    };
}

function previewFromApi(result: RangePreviewApiSuccess | BreakPreviewApiSuccess): GamePreview {
    if (result.direction === "BREAK") {
        return {
            kind: "BREAK",
            mintCost: BigInt(result.mintCost),
            effectivePayout: BigInt(result.effectivePayout),
            liveOdds: result.liveOdds,
            lowerLeg: {
                quantity: BigInt(result.lowerLeg.quantity),
                mintCost: BigInt(result.lowerLeg.mintCost),
                payout: BigInt(result.lowerLeg.payout),
                liveOdds: result.lowerLeg.liveOdds,
            },
            upperLeg: {
                quantity: BigInt(result.upperLeg.quantity),
                mintCost: BigInt(result.upperLeg.mintCost),
                payout: BigInt(result.upperLeg.payout),
                liveOdds: result.upperLeg.liveOdds,
            },
        };
    }
    return {
        kind: "RANGE",
        quantity: BigInt(result.quantity),
        mintCost: BigInt(result.mintCost),
        redeemPayout: BigInt(result.redeemPayout),
        liveOdds: result.liveOdds,
    };
}

function previewFailureReason(
    result: PromiseSettledResult<RangePreviewApiResponse>,
    prefix: RangeDirection,
): string {
    if (result.status === "rejected") {
        return `${prefix}_${result.reason instanceof Error ? result.reason.message : String(result.reason)}`;
    }
    if (result.value.ok) {
        return `${prefix}_PREVIEW_NOT_MINTABLE`;
    }
    return `${prefix}_${result.value.reason}`;
}

async function previewRangeForDisplay({
    address,
    market,
    budget,
}: {
    address: string;
    market: RangeMarket;
    budget: bigint;
}): Promise<DirectionPreviewResult> {
    const previewKey = buildPreviewKey({ direction: "RANGE", address, market, budget });
    const cached = successfulRangePreviewByKey.get(previewKey);
    if (cached) {
        return {
            ok: true,
            preview: cached.preview,
            previewKey: cached.previewKey,
            fromCache: true,
        };
    }
    const cooldownUntil = rangePreviewCooldownByKey.get(previewKey) ?? 0;
    if (cooldownUntil > Date.now()) {
        return { ok: false, reason: "Preview temporarily unavailable", fromCache: false };
    }
    const inFlight = inFlightRangePreviewByKey.get(previewKey);
    if (inFlight) {
        return inFlight;
    }
    const request = (async (): Promise<DirectionPreviewResult> => {
        try {
            const result = await fetchRangePreview({ direction: "RANGE", address, market, budget });
            if (!result.ok) {
                if (isRateLimitPreviewReason(result.reason)) {
                    rangePreviewCooldownByKey.set(
                        previewKey,
                        Date.now() + RANGE_PREVIEW_COOLDOWN_MS,
                    );
                }
                return {
                    ok: false,
                    reason: userFacingPreviewReason(result.reason),
                    fromCache: false,
                };
            }
            const preview = previewFromApi(result);
            if (
                preview.kind !== "RANGE" ||
                preview.mintCost <= 0n ||
                preview.mintCost > budget ||
                preview.quantity <= 0n
            ) {
                return { ok: false, reason: "RANGE_PREVIEW_NOT_MINTABLE", fromCache: false };
            }
            const cachedPreview = { preview, previewKey: result.previewKey };
            successfulRangePreviewByKey.set(previewKey, cachedPreview);
            rangePreviewCooldownByKey.delete(previewKey);
            return {
                ok: true,
                preview: cachedPreview.preview,
                previewKey: cachedPreview.previewKey,
                fromCache: false,
            };
        } catch (caught) {
            const reason = caught instanceof Error ? caught.message : String(caught);
            if (isRateLimitPreviewReason(reason)) {
                rangePreviewCooldownByKey.set(previewKey, Date.now() + RANGE_PREVIEW_COOLDOWN_MS);
            }
            return { ok: false, reason: userFacingPreviewReason(reason), fromCache: false };
        } finally {
            inFlightRangePreviewByKey.delete(previewKey);
        }
    })();
    inFlightRangePreviewByKey.set(previewKey, request);
    return request;
}

async function previewCandidate({
    address,
    market,
    budget,
}: {
    address: string;
    market: RangeMarket;
    budget: bigint;
}): Promise<
    | {
          ok: true;
          market: RangeMarket;
          rangePreview: RangePreview | null;
          rangePreviewKey: string | null;
          breakPreview: BreakPreview | null;
          breakPreviewKey: string | null;
          failureReason: string | null;
      }
    | { ok: false; market: RangeMarket; reason: string }
> {
    const [rangeSettled, breakSettled] = await Promise.allSettled([
        previewRangeForDisplay({ address, market, budget }),
        fetchRangePreview({ direction: "BREAK", address, market, budget }),
    ]);
    const failureReasons: string[] = [];
    let rangePreview: RangePreview | null = null;
    let rangePreviewKey: string | null = null;
    let breakPreview: BreakPreview | null = null;
    let breakPreviewKey: string | null = null;
    if (rangeSettled.status === "fulfilled" && rangeSettled.value.ok) {
        rangePreview = rangeSettled.value.preview;
        rangePreviewKey = rangeSettled.value.previewKey;
    } else if (rangeSettled.status === "fulfilled") {
        failureReasons.push(
            `RANGE_${readDirectionPreviewFailureReason(rangeSettled.value) ?? "PREVIEW_FAILED"}`,
        );
    } else {
        failureReasons.push(
            `RANGE_${rangeSettled.reason instanceof Error ? rangeSettled.reason.message : String(rangeSettled.reason)}`,
        );
    }
    if (breakSettled.status === "fulfilled" && breakSettled.value.ok) {
        const preview = previewFromApi(breakSettled.value);
        if (
            preview.kind === "BREAK" &&
            preview.mintCost > 0n &&
            preview.mintCost <= budget &&
            preview.effectivePayout > 0n &&
            preview.lowerLeg.quantity > 0n &&
            preview.upperLeg.quantity > 0n
        ) {
            breakPreview = preview;
            breakPreviewKey = breakSettled.value.previewKey;
        } else {
            failureReasons.push("BREAK_PREVIEW_NOT_MINTABLE");
        }
    } else {
        failureReasons.push(previewFailureReason(breakSettled, "BREAK"));
    }
    if (!rangePreview && !breakPreview) {
        return { ok: false, market, reason: failureReasons.join("; ") || "PREVIEW_NOT_MINTABLE" };
    }
    return {
        ok: true,
        market,
        rangePreview,
        rangePreviewKey,
        breakPreview,
        breakPreviewKey,
        failureReason: failureReasons.length > 0 ? failureReasons.join("; ") : null,
    };
}

function readBinaryMintEvents(events: unknown[]): MintedPositionEvent[] {
    const minted: MintedPositionEvent[] = [];
    for (const event of events) {
        if (!isRecord(event)) {
            continue;
        }
        if (
            event.eventType !== POSITION_MINTED_EVENT_TYPE &&
            event.type !== POSITION_MINTED_EVENT_TYPE
        ) {
            continue;
        }
        try {
            minted.push(readPositionMintedEvent(event));
        } catch (caught) {
            if (process.env.NODE_ENV !== "production") {
                console.warn("Skipping unparseable PositionMinted event", {
                    eventType: event.eventType,
                    type: event.type,
                    parsedJson: event.parsedJson,
                    json: event.json,
                    reason: caught instanceof Error ? caught.message : String(caught),
                });
            }
        }
    }
    return minted;
}

function normalizeTypeName(value: string): string {
    return value.toLowerCase().replace(/^0x/, "");
}

function findBreakMintLegs({
    events,
    market,
    managerId,
    trader,
}: {
    events: unknown[];
    market: RangeMarket;
    managerId: string;
    trader: string;
}): { lower: MintedPositionEvent | null; upper: MintedPositionEvent | null } {
    const minted = readBinaryMintEvents(events).filter(
        (event) =>
            event.trader.toLowerCase() === trader.toLowerCase() &&
            event.predictId === PREDICT_BINARY_CONFIG.predictObjectId &&
            event.managerId === managerId &&
            event.oracleId === market.oracleId &&
            event.expiryMs === market.expiryMs &&
            normalizeTypeName(event.quoteAssetName) ===
                normalizeTypeName(PREDICT_BINARY_CONFIG.quoteCoinType) &&
            event.quantity > 0n &&
            event.cost > 0n,
    );
    return {
        lower: minted.find((event) => event.strike === market.lowerStrike && !event.isUp) ?? null,
        upper: minted.find((event) => event.strike === market.higherStrike && event.isUp) ?? null,
    };
}

export function usePredictRange(roundMarket: PredictRoundMarket | null) {
    const account = useCurrentAccount();
    const network = useCurrentNetwork();
    const client = useCurrentClient();
    const dAppKit = useDAppKit();
    const address = account?.address ?? null;
    const isTestnet = network === PREDICT_BINARY_CONFIG.network;
    const currentOracleId = roundMarket?.currentOracle?.oracleId ?? null;
    const currentOracleExpiryMs = roundMarket?.currentOracle?.expiryMs ?? null;
    const binaryStrikeRaw = roundMarket?.round?.binaryStrikeRaw ?? null;
    const minStrikeRaw = roundMarket?.round?.minStrikeRaw ?? null;
    const tickSizeRaw = roundMarket?.round?.tickSizeRaw ?? null;
    const baseMarket = useMemo(
        () =>
            rangeBaseMarketFromRound({
                state: "LOADING",
                currentOracle:
                    currentOracleId && currentOracleExpiryMs !== null
                        ? {
                              oracleId: currentOracleId,
                              expiryMs: currentOracleExpiryMs,
                              lifecycle: "",
                              spotRaw: null,
                              forwardRaw: null,
                              timestampMs: null,
                              minStrikeRaw: null,
                              tickSizeRaw: null,
                          }
                        : null,
                previousOracle: null,
                nextOracle: null,
                round:
                    currentOracleId &&
                    currentOracleExpiryMs !== null &&
                    binaryStrikeRaw &&
                    minStrikeRaw &&
                    tickSizeRaw
                        ? {
                              roundId: "",
                              currentOracleId,
                              previousOracleId: "",
                              roundOpenMs: 0,
                              bettingCloseMs: 0,
                              expiryMs: currentOracleExpiryMs,
                              openingSpotRaw: "0",
                              binaryStrikeRaw,
                              minStrikeRaw,
                              tickSizeRaw,
                              state: "LOADING",
                          }
                        : null,
            }),
        [binaryStrikeRaw, currentOracleExpiryMs, currentOracleId, minStrikeRaw, tickSizeRaw],
    );
    const fixedMarket = useMemo(() => rangeMarketFromBase(baseMarket), [baseMarket]);
    const previewRequestRef = useRef(0);
    const inFlightDisplayPreviewKeyRef = useRef<string | null>(null);
    const lastSuccessfulDisplayPreviewKeyRef = useRef<string | null>(null);
    const cooldownByDisplayPreviewKeyRef = useRef<Map<string, number>>(new Map());
    const rangeSelectionDebugKeyRef = useRef<string | null>(null);
    const [direction, setDirection] = useState<RangeDirection>("RANGE");
    const [amount, setAmount] = useState("10");
    const [previewState, setPreviewState] = useState<RangePreviewState>(emptyPreview("IDLE"));
    const [message, setMessage] = useState("Choose RANGE for the current BTC band.");
    const [txStatus, setTxStatus] = useState<RangeTxStatus>("READY");
    const [lastBet, setLastBet] = useState<{
        direction: RangeDirection;
        cost: bigint;
        entryOdds: string;
    } | null>(null);
    const [hasJoinedArena, setHasJoinedArena] = useState(false);

    // ウォレット接続時にオンチェーンで参加済みか確認し、不要な join TX を防ぐ
    useEffect(() => {
        if (!address || !isTestnet) {
            setHasJoinedArena(false);
            return;
        }
        void checkArenaPlayerJoined(address).then((joined) => {
            if (joined) setHasJoinedArena(true);
        });
    }, [address, isTestnet]);

    const isBusy = txStatus === "CONFIRM IN WALLET" || txStatus === "SUBMITTING";
    const isBettingOpen = roundMarket?.state === "BETTING_OPEN";

    let budget: bigint | null = null;
    try {
        budget = parseTokenAmount(amount, PREDICT_BINARY_CONFIG.quoteDecimals).atomic;
    } catch {
        budget = null;
    }
    const displayPreviewKey =
        address && fixedMarket && budget !== null && budget > 0n
            ? buildDisplayPreviewKey({ address, market: fixedMarket, budget })
            : null;
    const selectedCandidate = previewState.selected;
    const selectedCandidateDisplayPreviewKey =
        address && selectedCandidate && budget !== null && budget > 0n
            ? buildDisplayPreviewKey({ address, market: selectedCandidate.market, budget })
            : null;
    const selectedDirectionPreview =
        selectedCandidate && direction === "RANGE"
            ? selectedCandidate.rangePreview
            : selectedCandidate?.breakPreview;
    const expectedPreviewKey =
        selectedCandidate && address && budget !== null
            ? buildPreviewKey({ direction, address, market: selectedCandidate.market, budget })
            : null;
    const selectedPreviewKey =
        selectedCandidate && direction === "RANGE"
            ? selectedCandidate.rangePreviewKey
            : selectedCandidate?.breakPreviewKey;
    // PREVIEWING 中も旧オッズで BET 可能とする。bet callback が送信直前に fresh re-fetch を行う
    const previewReady =
        (previewState.status === "READY" || previewState.status === "PREVIEWING") &&
        selectedDirectionPreview !== undefined;
    const canEnter =
        Boolean(address) &&
        isTestnet &&
        isBettingOpen &&
        Boolean(selectedCandidate) &&
        budget !== null &&
        budget > 0n &&
        previewReady &&
        !isBusy;
    const disabledReason = !address
        ? "Wallet not connected"
        : !isTestnet
          ? "Switch to Sui Testnet"
          : !isBettingOpen
            ? "Market is not open"
            : budget === null || budget <= 0n
              ? "Invalid amount"
              : !selectedCandidate
                ? (previewState.error ?? "Odds unavailable")
                : !selectedDirectionPreview
                  ? (previewState.error ?? "Odds unavailable")
                  : !previewReady
                    ? "Odds unavailable"
                    : isBusy
                      ? "Transaction pending"
                      : null;

    useEffect(() => {
        const round = roundMarket?.round;
        if (process.env.NODE_ENV === "production" || !baseMarket || !round) {
            return;
        }
        const debugKey = [
            baseMarket.oracleId,
            baseMarket.expiryMs,
            round.openingSpotRaw,
            round.binaryStrikeRaw,
            round.tickSizeRaw,
            fixedMarket?.widthTicks.toString() ?? "none",
        ].join(":");
        if (rangeSelectionDebugKeyRef.current === debugKey) {
            return;
        }
        rangeSelectionDebugKeyRef.current = debugKey;
        console.info("Range candidate strike selection", {
            oracleId: baseMarket.oracleId,
            expiryMs: baseMarket.expiryMs,
            oracleTimestampMs: baseMarket.oracleTimestampMs,
            openingSpotRaw: round.openingSpotRaw,
            referenceStrikeRaw: round.binaryStrikeRaw,
            minStrikeRaw: round.minStrikeRaw,
            tickSizeRaw: round.tickSizeRaw,
            fixedWidthTicks: FIXED_RANGE_WIDTH_TICKS.toString(),
            fixedMarket: fixedMarket
                ? {
                      widthTicks: fixedMarket.widthTicks.toString(),
                      lowerStrikeRaw: fixedMarket.lowerStrike.toString(),
                      higherStrikeRaw: fixedMarket.higherStrike.toString(),
                      lowerDisplay: formatRawPrice(fixedMarket.lowerStrike),
                      higherDisplay: formatRawPrice(fixedMarket.higherStrike),
                      rangeWidthDisplay: formatRawPriceDelta(
                          fixedMarket.higherStrike - fixedMarket.lowerStrike,
                      ),
                  }
                : null,
        });
    }, [baseMarket, fixedMarket, roundMarket]);

    useEffect(() => {
        const logPreviewDecision = (payload: Record<string, unknown>) => {
            if (process.env.NODE_ENV !== "production") {
                console.info("Range display preview decision", payload);
            }
        };
        if (!address || !isTestnet || !fixedMarket || budget === null || budget <= 0n) {
            previewRequestRef.current += 1;
            const clearReason = !address
                ? "wallet address missing"
                : !isTestnet
                  ? "network mismatch"
                  : !fixedMarket
                    ? "fixed market unavailable"
                    : "invalid amount";
            logPreviewDecision({
                displayPreviewKey,
                triggerReason: "preview inputs invalid",
                skippedReason: clearReason,
                selectedCandidateCleared: true,
            });
            lastSuccessfulDisplayPreviewKeyRef.current = null;
            setPreviewState(emptyPreview("IDLE"));
            return;
        }
        if (!displayPreviewKey) {
            return;
        }
        if (!isBettingOpen) {
            logPreviewDecision({
                displayPreviewKey,
                triggerReason: "market not open",
                skippedReason: "market not open",
                selectedCandidateKept: true,
            });
            setPreviewState((current) => ({
                status: current.selected ? "READY" : "IDLE",
                selected: current.selected,
                error: null,
            }));
            return;
        }
        if (
            lastSuccessfulDisplayPreviewKeyRef.current === displayPreviewKey &&
            selectedCandidateDisplayPreviewKey === displayPreviewKey &&
            inFlightDisplayPreviewKeyRef.current !== displayPreviewKey
        ) {
            logPreviewDecision({
                displayPreviewKey,
                triggerReason: "dependencies updated",
                skippedReason: "last successful preview already matches",
                selectedCandidateKept: true,
            });
            return;
        }
        if (inFlightDisplayPreviewKeyRef.current === displayPreviewKey) {
            logPreviewDecision({
                displayPreviewKey,
                triggerReason: "dependencies updated",
                skippedReason: "in-flight duplicate",
                inFlightDuplicate: true,
                selectedCandidateKept: true,
            });
            return;
        }
        const cooldownUntil = cooldownByDisplayPreviewKeyRef.current.get(displayPreviewKey) ?? 0;
        const now = Date.now();
        if (cooldownUntil > now) {
            logPreviewDecision({
                displayPreviewKey,
                triggerReason: "dependencies updated",
                skippedReason: "cooldown",
                cooldownMsRemaining: cooldownUntil - now,
                selectedCandidateKept: true,
            });
            setPreviewState((current) => ({
                status: current.selected ? "READY" : "ERROR",
                selected: current.selected,
                error: "Preview temporarily unavailable",
            }));
            return;
        }

        previewRequestRef.current += 1;
        const requestId = previewRequestRef.current;
        inFlightDisplayPreviewKeyRef.current = displayPreviewKey;
        logPreviewDecision({
            displayPreviewKey,
            triggerReason: "display preview key changed or no cached success",
            skippedReason: null,
            inFlightDuplicate: false,
            cooldown: false,
            selectedCandidateKept: true,
        });
        setPreviewState((current) => ({
            status: "PREVIEWING",
            selected: current.selected,
            error: null,
        }));
        void (async () => {
            try {
                const preview = await previewCandidate({ address, market: fixedMarket, budget });
                if (previewRequestRef.current !== requestId) {
                    return;
                }
                if (process.env.NODE_ENV !== "production") {
                    const market = preview.market;
                    console.info(
                        preview.ok ? "Range fixed preview" : "Range fixed preview failed",
                        preview.ok
                            ? {
                                  displayPreviewKey,
                                  fixedWidthTicks: FIXED_RANGE_WIDTH_TICKS.toString(),
                                  lowerStrikeRaw: market.lowerStrike.toString(),
                                  higherStrikeRaw: market.higherStrike.toString(),
                                  lowerDisplay: formatRawPrice(market.lowerStrike),
                                  higherDisplay: formatRawPrice(market.higherStrike),
                                  rangeWidthDisplay: formatRawPriceDelta(
                                      market.higherStrike - market.lowerStrike,
                                  ),
                                  rangeMintCost: preview.rangePreview?.mintCost.toString() ?? null,
                                  rangeQuantity: preview.rangePreview?.quantity.toString() ?? null,
                                  rangeOdds: preview.rangePreview?.liveOdds ?? null,
                                  breakLowerMintCost:
                                      preview.breakPreview?.lowerLeg.mintCost.toString() ?? null,
                                  breakLowerQuantity:
                                      preview.breakPreview?.lowerLeg.quantity.toString() ?? null,
                                  breakUpperMintCost:
                                      preview.breakPreview?.upperLeg.mintCost.toString() ?? null,
                                  breakUpperQuantity:
                                      preview.breakPreview?.upperLeg.quantity.toString() ?? null,
                                  breakEffectivePayout:
                                      preview.breakPreview?.effectivePayout.toString() ?? null,
                                  breakTotalCost: preview.breakPreview?.mintCost.toString() ?? null,
                                  breakEffectiveOdds: preview.breakPreview?.liveOdds ?? null,
                                  partialFailureReason: preview.failureReason,
                              }
                            : {
                                  displayPreviewKey,
                                  fixedWidthTicks: FIXED_RANGE_WIDTH_TICKS.toString(),
                                  lowerStrikeRaw: market.lowerStrike.toString(),
                                  higherStrikeRaw: market.higherStrike.toString(),
                                  lowerDisplay: formatRawPrice(market.lowerStrike),
                                  higherDisplay: formatRawPrice(market.higherStrike),
                                  rangeWidthDisplay: formatRawPriceDelta(
                                      market.higherStrike - market.lowerStrike,
                                  ),
                                  failureReason: preview.reason,
                              },
                    );
                }
                if (!preview.ok) {
                    if (isRateLimitPreviewReason(preview.reason)) {
                        cooldownByDisplayPreviewKeyRef.current.set(
                            displayPreviewKey,
                            Date.now() + RANGE_PREVIEW_COOLDOWN_MS,
                        );
                    }
                    setPreviewState((current) => ({
                        status: current.selected ? "READY" : "ERROR",
                        selected: current.selected,
                        error: isRateLimitPreviewReason(preview.reason)
                            ? "Preview temporarily unavailable"
                            : preview.reason,
                    }));
                    return;
                }
                const partialFailureReason = userFacingAggregatePreviewReason(
                    preview.failureReason,
                );
                if (partialFailureReason && isRateLimitPreviewReason(preview.failureReason ?? "")) {
                    cooldownByDisplayPreviewKeyRef.current.set(
                        displayPreviewKey,
                        Date.now() + RANGE_PREVIEW_COOLDOWN_MS,
                    );
                } else {
                    cooldownByDisplayPreviewKeyRef.current.delete(displayPreviewKey);
                }
                if (!partialFailureReason) {
                    lastSuccessfulDisplayPreviewKeyRef.current = displayPreviewKey;
                }
                setPreviewState((current) => {
                    const currentKey =
                        current.selected && budget > 0n
                            ? buildDisplayPreviewKey({
                                  address,
                                  market: current.selected.market,
                                  budget,
                              })
                            : null;
                    const canReuseCurrent = currentKey === displayPreviewKey;
                    return {
                        status: "READY",
                        selected: {
                            ...preview,
                            rangePreview:
                                preview.rangePreview ??
                                (canReuseCurrent ? (current.selected?.rangePreview ?? null) : null),
                            rangePreviewKey:
                                preview.rangePreviewKey ??
                                (canReuseCurrent
                                    ? (current.selected?.rangePreviewKey ?? null)
                                    : null),
                            breakPreview:
                                preview.breakPreview ??
                                (canReuseCurrent ? (current.selected?.breakPreview ?? null) : null),
                            breakPreviewKey:
                                preview.breakPreviewKey ??
                                (canReuseCurrent
                                    ? (current.selected?.breakPreviewKey ?? null)
                                    : null),
                        },
                        error: partialFailureReason,
                    };
                });
            } catch (caught) {
                if (previewRequestRef.current !== requestId) {
                    return;
                }
                console.warn("Range preview failed", {
                    displayPreviewKey,
                    reason: caught instanceof Error ? caught.message : String(caught),
                });
                setPreviewState((current) => ({
                    status: current.selected ? "READY" : "ERROR",
                    selected: current.selected,
                    error: "Preview temporarily unavailable",
                }));
            } finally {
                if (inFlightDisplayPreviewKeyRef.current === displayPreviewKey) {
                    inFlightDisplayPreviewKeyRef.current = null;
                }
            }
        })();
    }, [
        address,
        budget,
        displayPreviewKey,
        fixedMarket,
        isBettingOpen,
        isTestnet,
        selectedCandidateDisplayPreviewKey,
    ]);

    const placeRangeBet = useCallback(async () => {
        const handleCaught = (caught: unknown) => {
            if (isWalletUserRejection(caught)) {
                console.info("Range transaction cancelled", readWalletCancellationDebug(caught));
                setTxStatus("READY");
                setMessage("Transaction cancelled");
                return;
            }
            console.error("Range mint failed", caught);
            setTxStatus("FAILED");
            setMessage(readWalletErrorMessage(caught));
        };

        try {
            if (
                !address ||
                !selectedCandidate ||
                !selectedDirectionPreview ||
                budget === null ||
                !previewReady
            ) {
                setTxStatus("FAILED");
                setMessage("Odds unavailable. Please wait or refresh.");
                return;
            }
            setTxStatus("SUBMITTING");
            setMessage("Preparing transaction");
            const market = selectedCandidate.market;
            let latestPreview = selectedDirectionPreview;
            let latestPreviewKey = selectedPreviewKey;
            let previewSource = "display-preview";
            if (latestPreviewKey !== expectedPreviewKey) {
                let latest: RangePreviewApiResponse;
                try {
                    latest = await withTimeout(
                        fetchRangePreview({ direction, address, market, budget }),
                        15_000,
                        "Range preview timed out",
                    );
                } catch (caught) {
                    console.info("Range enter preview unavailable", {
                        direction,
                        expectedPreviewKey,
                        reason: caught instanceof Error ? caught.message : String(caught),
                    });
                    setPreviewState((current) => ({
                        status: current.selected ? "READY" : "ERROR",
                        selected: current.selected,
                        error: current.selected ? current.error : "Odds unavailable",
                    }));
                    setTxStatus("FAILED");
                    setMessage("Odds unavailable. Please wait or refresh.");
                    return;
                }
                if (process.env.NODE_ENV !== "production") {
                    console.info("Range enter latest preview", {
                        direction,
                        ok: latest.ok,
                        previewKey: latest.previewKey,
                        expectedPreviewKey,
                        reason: latest.ok ? null : latest.reason,
                    });
                }
                if (!latest.ok || latest.previewKey !== expectedPreviewKey) {
                    setPreviewState((current) => ({
                        status: current.selected ? "READY" : "ERROR",
                        selected: current.selected,
                        error: current.selected ? current.error : "Odds unavailable",
                    }));
                    setTxStatus("FAILED");
                    setMessage("Odds unavailable. Please wait or refresh.");
                    return;
                }
                latestPreview = previewFromApi(latest);
                latestPreviewKey = latest.previewKey;
                previewSource = "latest-preview";
            }
            if (process.env.NODE_ENV !== "production") {
                console.info("Range enter preview selected", {
                    direction,
                    previewSource,
                    previewKey: latestPreviewKey,
                    expectedPreviewKey,
                });
            }
            if (
                latestPreview.kind !== direction ||
                latestPreview.mintCost <= 0n ||
                latestPreview.mintCost > budget
            ) {
                setTxStatus("FAILED");
                setMessage("Odds unavailable. Please wait or refresh.");
                return;
            }
            setPreviewState({
                status: "READY",
                selected: {
                    ...selectedCandidate,
                    ...(latestPreview.kind === "RANGE"
                        ? { rangePreview: latestPreview, rangePreviewKey: latestPreviewKey }
                        : { breakPreview: latestPreview, breakPreviewKey: latestPreviewKey }),
                },
                error: null,
            });
            let managerId = await withTimeout(
                findPredictManager(address),
                15_000,
                "PredictManager lookup timed out",
            );
            if (!managerId) {
                const createMoveCalls = describeCreatePredictManagerMoveCalls();
                console.info("Range manager creation transaction", { moveCalls: createMoveCalls });
                setTxStatus("CONFIRM IN WALLET");
                setMessage("CONFIRM IN WALLET");
                const createResult = await dAppKit.signAndExecuteTransaction({
                    transaction: createPredictManagerTransaction(address),
                });
                const createDigest = readDigest(createResult);
                const created = await client.core.waitForTransaction({
                    digest: createDigest,
                    timeout: 60_000,
                    include: { events: true },
                });
                managerId = readManagerCreatedEvent(readTransactionEvents(created));
                if (!managerId) {
                    throw new Error("PredictManager creation could not be confirmed");
                }
            }
            // Arena への参加登録が未完了の場合は先に join する
            let nextHasJoined = hasJoinedArena;
            if (!nextHasJoined) {
                // state が stale の可能性があるのでオンチェーンで再確認
                nextHasJoined = await checkArenaPlayerJoined(address);
                if (nextHasJoined) setHasJoinedArena(true);
            }
            if (!nextHasJoined) {
                setTxStatus("CONFIRM IN WALLET");
                setMessage("CONFIRM IN WALLET (Arena Join)");
                try {
                    const joinResult = await dAppKit.signAndExecuteTransaction({
                        transaction: createJoinArenaTransaction({ sender: address, managerId }),
                    });
                    const joinDigest = readDigest(joinResult);
                    await client.core.waitForTransaction({ digest: joinDigest, timeout: 60_000 });
                    setHasJoinedArena(true);
                    nextHasJoined = true;
                } catch (joinError) {
                    // 既に参加済み (EAlreadyJoined = 3) の場合はそのまま続行
                    const msg = (
                        joinError instanceof Error ? joinError.message : String(joinError)
                    ).toLowerCase();
                    if (
                        (msg.includes("moveabort") || msg.includes("abort")) &&
                        msg.includes(", 3)")
                    ) {
                        setHasJoinedArena(true);
                        nextHasJoined = true;
                    } else {
                        throw joinError;
                    }
                }
            }

            const commonInput = {
                sender: address,
                managerId,
                oracleId: market.oracleId,
                expiryMs: market.expiryMs,
                lowerStrike: market.lowerStrike,
                higherStrike: market.higherStrike,
            };
            const rangeMaxTotalCost = calcMaxTotalCost(
                latestPreview.mintCost,
                PREDICT_BINARY_CONFIG.feeBps,
            );
            const tx =
                latestPreview.kind === "RANGE"
                    ? createMintRangeTransaction({
                          ...commonInput,
                          quantity: latestPreview.quantity,
                          depositAmount: rangeMaxTotalCost,
                          maxTotalCost: rangeMaxTotalCost,
                      })
                    : createMintBreakTransaction({
                          ...commonInput,
                          lowerQuantity: latestPreview.lowerLeg.quantity,
                          upperQuantity: latestPreview.upperLeg.quantity,
                          depositAmount: rangeMaxTotalCost,
                          maxTotalCost: rangeMaxTotalCost,
                      });
            const moveCalls =
                latestPreview.kind === "RANGE"
                    ? describeMintRangeMoveCalls({
                          ...commonInput,
                          quantity: latestPreview.quantity,
                          depositAmount: rangeMaxTotalCost,
                          maxTotalCost: rangeMaxTotalCost,
                      })
                    : describeMintBreakMoveCalls({
                          ...commonInput,
                          lowerQuantity: latestPreview.lowerLeg.quantity,
                          upperQuantity: latestPreview.upperLeg.quantity,
                          depositAmount: rangeMaxTotalCost,
                          maxTotalCost: rangeMaxTotalCost,
                      });
            console.info("Range card mint transaction before wallet approval", {
                direction,
                moveCalls,
                oracleId: market.oracleId,
                expiryMs: market.expiryMs,
                lowerStrikeRaw: market.lowerStrike.toString(),
                higherStrikeRaw: market.higherStrike.toString(),
                mintCost: latestPreview.mintCost.toString(),
            });
            setTxStatus("CONFIRM IN WALLET");
            setMessage("CONFIRM IN WALLET");
            const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
            const digest = readDigest(result);
            setTxStatus("SUBMITTING");
            setMessage("SUBMITTING");
            const executed = await client.core.waitForTransaction({
                digest,
                timeout: 60_000,
                include: { events: true, effects: true, balanceChanges: true, transaction: true },
            });
            const events = readTransactionEvents(executed);
            if (latestPreview.kind === "RANGE") {
                const mint = readRangeMintedEvent(events);
                if (
                    mint.oracleId !== market.oracleId ||
                    mint.expiryMs !== market.expiryMs ||
                    mint.lowerStrike !== market.lowerStrike ||
                    mint.higherStrike !== market.higherStrike ||
                    mint.quantity <= 0n ||
                    mint.cost <= 0n
                ) {
                    throw new Error("Range mint event did not match the selected range");
                }
                setLastBet({
                    direction: "RANGE",
                    cost: mint.cost,
                    entryOdds: formatBinaryOddsFromQuantity(mint.quantity, mint.cost),
                });
            } else {
                const { lower, upper } = findBreakMintLegs({
                    events,
                    market,
                    managerId,
                    trader: address,
                });
                if (
                    !lower ||
                    !upper ||
                    (lower.digest && upper.digest && lower.digest !== upper.digest)
                ) {
                    console.warn("Break position confirmation failed", {
                        digest,
                        eventTypes: events
                            .filter(isRecord)
                            .map((event) => event.eventType ?? event.type),
                        lowerFound: Boolean(lower),
                        upperFound: Boolean(upper),
                        lowerDigest: lower?.digest ?? null,
                        upperDigest: upper?.digest ?? null,
                        managerId,
                        trader: address,
                        oracleId: market.oracleId,
                        expiryMs: market.expiryMs,
                        lowerStrikeRaw: market.lowerStrike.toString(),
                        higherStrikeRaw: market.higherStrike.toString(),
                    });
                    setTxStatus("FAILED");
                    setMessage("Break position confirmation failed");
                    requestBalanceRefresh("range:break-confirmation-failed");
                    return;
                }
                const cost = lower.cost + upper.cost;
                const effectivePayout =
                    lower.quantity < upper.quantity ? lower.quantity : upper.quantity;
                setLastBet({
                    direction: "BREAK",
                    cost,
                    entryOdds: formatBinaryOddsFromQuantity(effectivePayout, cost),
                });
            }
            setTxStatus("PLACED");
            setMessage(`${direction} PLACED`);
            requestBalanceRefresh("range:mint-confirmed");
        } catch (caught) {
            handleCaught(caught);
        }
    }, [
        address,
        budget,
        client,
        dAppKit,
        direction,
        expectedPreviewKey,
        hasJoinedArena,
        previewReady,
        selectedCandidate,
        selectedDirectionPreview,
        selectedPreviewKey,
    ]);

    return {
        direction,
        setDirection,
        amount,
        setAmount,
        txStatus,
        message,
        isBettingOpen,
        canEnter,
        marketLabel: selectedCandidate
            ? `${formatRawPrice(selectedCandidate.market.lowerStrike)} - ${formatRawPrice(
                  selectedCandidate.market.higherStrike,
              )}`
            : fixedMarket
              ? `${formatRawPrice(fixedMarket.lowerStrike)} - ${formatRawPrice(
                    fixedMarket.higherStrike,
                )}`
              : "--",
        rangeOdds: selectedCandidate?.rangePreview
            ? selectedCandidate.rangePreview.liveOdds
            : previewState.status === "PREVIEWING"
              ? "Calculating..."
              : "Unavailable",
        breakOdds: selectedCandidate?.breakPreview
            ? selectedCandidate.breakPreview.liveOdds
            : previewState.status === "PREVIEWING"
              ? "Calculating..."
              : "Unavailable",
        expectedPayout:
            selectedCandidate?.rangePreview?.quantity &&
            selectedCandidate.rangePreview.quantity > 0n
                ? `${formatTokenAmount(
                      selectedCandidate.rangePreview.quantity,
                      PREDICT_BINARY_CONFIG.quoteDecimals,
                  )} DUSDC`
                : null,
        breakPayoutLabel: selectedCandidate?.breakPreview
            ? `Lower break payout ${formatTokenAmount(
                  selectedCandidate.breakPreview.lowerLeg.payout,
                  PREDICT_BINARY_CONFIG.quoteDecimals,
              )} DUSDC · Upper break payout ${formatTokenAmount(
                  selectedCandidate.breakPreview.upperLeg.payout,
                  PREDICT_BINARY_CONFIG.quoteDecimals,
              )} DUSDC`
            : null,
        entryDirection: lastBet?.direction ?? null,
        entryOdds: lastBet?.entryOdds ?? null,
        entryCost: lastBet
            ? `${formatTokenAmount(lastBet.cost, PREDICT_BINARY_CONFIG.quoteDecimals)} DUSDC`
            : null,
        unavailableReason: previewState.error,
        disabledReason,
        displayDebug: {
            selectedDirection: direction,
            hasSelectedCandidate: Boolean(selectedCandidate),
            hasSelectedPreview: Boolean(selectedDirectionPreview),
            canBet: canEnter,
            selectedWidthTicks: selectedCandidate?.market.widthTicks.toString() ?? null,
            selectedLowerDisplay: selectedCandidate
                ? formatRawPrice(selectedCandidate.market.lowerStrike)
                : null,
            selectedHigherDisplay: selectedCandidate
                ? formatRawPrice(selectedCandidate.market.higherStrike)
                : null,
            rangeOddsLabel: selectedCandidate?.rangePreview?.liveOdds ?? "Unavailable",
            breakOddsLabel: selectedCandidate?.breakPreview?.liveOdds ?? "Unavailable",
            rangeOdds: selectedCandidate?.rangePreview?.liveOdds ?? "Unavailable",
            breakOdds: selectedCandidate?.breakPreview?.liveOdds ?? "Unavailable",
            previewKey: selectedPreviewKey,
            expectedPreviewKey,
            amountAtomic: budget?.toString() ?? null,
            rangePreviewOk: Boolean(selectedCandidate?.rangePreview),
            breakPreviewOk: Boolean(selectedCandidate?.breakPreview),
            disabledReason,
            unavailableReason: previewState.error,
        },
        placeRangeBet,
    };
}
