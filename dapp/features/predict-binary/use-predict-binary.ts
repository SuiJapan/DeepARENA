"use client";

import {
    useCurrentAccount,
    useCurrentClient,
    useCurrentNetwork,
    useDAppKit,
} from "@mysten/dapp-kit-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PredictRoundMarket } from "@/features/predict-round/use-predict-round";
import { requestBalanceRefresh } from "@/lib/balance-refresh";
import { formatTokenAmount, parseTokenAmount } from "@/lib/plp-sandbox/amounts";
import {
    type BtcBinaryMarket,
    type BudgetedTradePreview,
    checkArenaPlayerJoined,
    findMintEvent,
    findPredictManager,
    type MintEvent,
    type MintedPositionEvent,
    POSITION_MINTED_EVENT_TYPE,
    queryPositionMintedEvents,
    type RedeemEvent,
    readDigest,
    readManagerCreatedEvent,
    readMintEvent,
    readRedeemEvent,
    readWalletQuoteBalance,
    saveCachedManagerId,
} from "@/lib/predict-binary/client";
import { PREDICT_BINARY_CONFIG, predictBinaryExplorerUrl } from "@/lib/predict-binary/config";
import { readSuiEventPayloads } from "@/lib/predict-binary/events";
import { formatBinaryOddsFromQuantity } from "@/lib/predict-binary/odds";
import {
    buildBinaryPreviewCacheKey,
    buildBinaryPreviewRequestKey,
} from "@/lib/predict-binary/preview-key";
import {
    calcFee,
    calcMaxTotalCost,
    createJoinArenaTransaction,
    createMintBinaryTransaction,
    createPredictManagerTransaction,
    createRedeemBinaryTransaction,
    describeCreatePredictManagerMoveCalls,
    describeMintBinaryMoveCalls,
    maxStakeWithinDeposit,
} from "@/lib/predict-binary/transactions";
import { isWalletUserRejection, readWalletCancellationDebug } from "@/lib/wallet-errors";

/** Sui MoveAbort で EAlreadyJoined(=3) が返った場合に true */
function isArenaAlreadyJoinedError(error: unknown): boolean {
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return (msg.includes("moveabort") || msg.includes("abort")) && msg.includes(", 3)");
}

export type BinaryDirection = "UP" | "DOWN";
export type BinaryTxStatus =
    | "READY"
    | "CONFIRM IN WALLET"
    | "SUBMITTING"
    | "BET PLACED"
    | "FAILED"
    | "WON"
    | "LOST";
export type BinaryPreviewStatus = "IDLE" | "PREVIEWING" | "READY" | "UNAVAILABLE" | "ERROR";

interface SidePreviewState {
    status: BinaryPreviewStatus;
    preview: BudgetedTradePreview | null;
    error: string | null;
    debug: BinaryPreviewDebug | null;
    previewKey: string | null;
}

interface BetAvailability {
    canBet: boolean;
    reason: string;
    previewKey: string | null;
    expectedPreviewKey: string | null;
    previewOk: boolean;
    previewReason: string | null;
    quantity: string | null;
    mintCost: string | null;
}

interface BinaryPositionState {
    direction: BinaryDirection;
    quantity: bigint;
    cost: bigint;
    payout: bigint | null;
    entryOdds: string | null;
    strike: bigint;
    expiryMs: number;
    oracleId: string;
    digest?: string;
}

type BinarySidePositions = Record<BinaryDirection, BinaryPositionState | null>;

function emptySidePositions(): BinarySidePositions {
    return { UP: null, DOWN: null };
}

function readErrorMessage(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}

class BetValidationError extends Error {
    constructor(
        message: string,
        readonly debug: unknown,
    ) {
        super(message);
        this.name = "BetValidationError";
    }
}

function toConsoleValue(value: unknown): unknown {
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (Array.isArray(value)) {
        return value.map(toConsoleValue);
    }
    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
            Object.entries(value).map(([key, nested]) => [key, toConsoleValue(nested)]),
        );
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNestedRecord(value: unknown, key: string): Record<string, unknown> | null {
    return isRecord(value) && isRecord(value[key]) ? value[key] : null;
}

function readTransactionEffects(value: unknown): Record<string, unknown> | null {
    return readNestedRecord(readNestedRecord(value, "Transaction"), "effects");
}

function readTransactionEvents(value: unknown): unknown[] {
    if (isRecord(value) && Array.isArray(value.events)) {
        return value.events;
    }
    const transaction = readNestedRecord(value, "Transaction");
    return transaction && Array.isArray(transaction.events) ? transaction.events : [];
}

function readTransactionEffectField(value: unknown, fieldName: string): unknown {
    return readTransactionEffects(value)?.[fieldName] ?? null;
}

function requestPostTransactionBalanceRefresh(reason: string): void {
    requestBalanceRefresh(reason);
    window.setTimeout(() => requestBalanceRefresh(`${reason}:delayed`), 1_500);
}

function logPositionMintedEventDetails(event: unknown, mint: MintEvent | null): void {
    const payloads = readSuiEventPayloads(event);
    console.info("Binary PositionMinted event detail", {
        eventType: isRecord(event) ? (event.eventType ?? event.type ?? null) : null,
        parsedJson: toConsoleValue(payloads.parsedJson),
        json: toConsoleValue(payloads.json),
        predict_id:
            mint?.predictId ?? payloads.parsedJson?.predict_id ?? payloads.json?.predict_id ?? null,
        oracle_id:
            mint?.oracleId ?? payloads.parsedJson?.oracle_id ?? payloads.json?.oracle_id ?? null,
        expiry:
            mint?.expiryMs.toString() ??
            payloads.parsedJson?.expiry ??
            payloads.json?.expiry ??
            null,
        strike:
            mint?.strike.toString() ?? payloads.parsedJson?.strike ?? payloads.json?.strike ?? null,
        is_up: mint?.isUp ?? payloads.parsedJson?.is_up ?? payloads.json?.is_up ?? null,
        quantity:
            mint?.quantity.toString() ??
            payloads.parsedJson?.quantity ??
            payloads.json?.quantity ??
            null,
        cost: mint?.cost.toString() ?? payloads.parsedJson?.cost ?? payloads.json?.cost ?? null,
        ask_price:
            mint?.askPrice.toString() ??
            payloads.parsedJson?.ask_price ??
            payloads.json?.ask_price ??
            null,
    });
}

function directionFromBool(isUp: boolean): BinaryDirection {
    return isUp ? "UP" : "DOWN";
}

function positionFromMintEvent(mint: MintEvent, digest: string): BinaryPositionState {
    const entryOdds = formatBinaryOddsFromQuantity(mint.quantity, mint.cost);
    return {
        direction: directionFromBool(mint.isUp),
        quantity: mint.quantity,
        cost: mint.cost,
        payout: null,
        entryOdds,
        strike: mint.strike,
        expiryMs: mint.expiryMs,
        oracleId: mint.oracleId,
        digest,
    };
}

function mergeMintedSidePosition(
    current: BinaryPositionState | null,
    next: BinaryPositionState,
): BinaryPositionState {
    if (
        !current ||
        current.direction !== next.direction ||
        current.strike !== next.strike ||
        current.expiryMs !== next.expiryMs ||
        current.oracleId !== next.oracleId
    ) {
        return next;
    }
    const quantity = current.quantity + next.quantity;
    const cost = current.cost + next.cost;
    return {
        ...next,
        quantity,
        cost,
        entryOdds: formatBinaryOddsFromQuantity(quantity, cost),
    };
}

function sidePositionsFromMintedEvents(events: MintedPositionEvent[]): BinarySidePositions {
    const restored = emptySidePositions();
    for (const event of events) {
        const position = positionFromMintEvent(event, event.digest ?? "");
        restored[position.direction] = mergeMintedSidePosition(
            restored[position.direction],
            position,
        );
    }
    return restored;
}

interface BinaryPreviewDebug {
    reason: string;
    devInspectError: string | null;
    moveAbortCode: string | null;
    moveTarget: string | null;
    transactionInputs: unknown;
    lastTriedQuantity: string | null;
    lastMintCost: string | null;
    lastRedeemPayout: string | null;
    returnValuesRaw: unknown;
    decodedMintCost: string | null;
    decodedRedeemPayout: string | null;
}

interface BinaryPreviewSideSuccess {
    ok: true;
    quantity: string;
    mintCost: string;
    redeemPayout: string;
    liveOdds: string;
    debug: BinaryPreviewDebug;
}

interface BinaryPreviewSideFailure {
    ok: false;
    error: string;
    debug: BinaryPreviewDebug;
}

type BinaryPreviewSideResponse = BinaryPreviewSideSuccess | BinaryPreviewSideFailure;

interface BinaryPreviewApiResponse {
    ok: true;
    previewKey: string;
    cacheHit: boolean;
    up: BinaryPreviewSideResponse;
    down: BinaryPreviewSideResponse;
}

type PreviewCachePolicy = "read-through" | "bypass";

interface ParsedBinaryPreviewSide {
    ok: boolean;
    preview: BudgetedTradePreview | null;
    error: string | null;
    debug: BinaryPreviewDebug;
}

function previewFromApiSide(result: BinaryPreviewSideResponse): ParsedBinaryPreviewSide {
    if (!result.ok) {
        return {
            ok: false,
            preview: null,
            error: result.error,
            debug: result.debug,
        };
    }
    const preview = {
        quantity: BigInt(result.quantity),
        firstTriedQuantity: 1n,
        mintCost: BigInt(result.mintCost),
        redeemPayout: BigInt(result.redeemPayout),
        debug: result.debug,
    };
    return { ok: true, preview, error: null, debug: result.debug };
}

function buildPreviewApiKey({
    market,
    budget,
}: {
    market: BtcBinaryMarket;
    budget: bigint;
}): string {
    return buildBinaryPreviewCacheKey({
        oracleId: market.oracleId,
        expiryMs: market.expiryMs,
        referenceStrikeRaw: market.strike,
        betAmountAtomic: budget,
    });
}

function getBetAvailability({
    canTrade,
    hasPositiveAmount,
    state,
    expectedPreviewKey,
}: {
    canTrade: boolean;
    hasPositiveAmount: boolean;
    state: SidePreviewState;
    expectedPreviewKey: string | null;
}): BetAvailability {
    const previewReason = state.debug?.reason ?? state.error;
    const previewOk =
        Boolean(state.preview) &&
        state.previewKey !== null &&
        state.previewKey === expectedPreviewKey &&
        state.status !== "ERROR" &&
        state.status !== "UNAVAILABLE";
    const base = {
        previewKey: state.previewKey,
        expectedPreviewKey,
        previewOk,
        previewReason,
        quantity: state.preview?.quantity.toString() ?? null,
        mintCost: state.preview?.mintCost.toString() ?? null,
    };
    if (!canTrade) {
        return { ...base, canBet: false, reason: "Market is not currently mintable." };
    }
    if (!hasPositiveAmount) {
        return { ...base, canBet: false, reason: "Enter an amount." };
    }
    if (
        !state.preview ||
        !previewOk ||
        state.status === "ERROR" ||
        state.status === "UNAVAILABLE"
    ) {
        return {
            ...base,
            canBet: false,
            reason:
                state.status === "PREVIEWING"
                    ? "Calculating odds. Please wait."
                    : "Odds unavailable. Please wait or refresh.",
        };
    }
    if (state.preview.quantity <= 0n || state.preview.mintCost <= 0n) {
        return { ...base, canBet: false, reason: "Market is not currently mintable." };
    }
    return { ...base, canBet: true, reason: "OK" };
}

async function previewBinaryOddsViaApi({
    address,
    market,
    budget,
    oracleTimestampMs,
    cachePolicy = "read-through",
}: {
    address: string;
    market: BtcBinaryMarket;
    budget: bigint;
    oracleTimestampMs: number | null;
    cachePolicy?: PreviewCachePolicy;
}): Promise<{
    previewKey: string;
    cacheHit: boolean;
    up: ParsedBinaryPreviewSide;
    down: ParsedBinaryPreviewSide;
}> {
    const response = await fetch("/api/predict/binary-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            walletAddress: address,
            betAmountAtomic: budget.toString(),
            oracleId: market.oracleId,
            expiryMs: market.expiryMs.toString(),
            referenceStrikeRaw: market.strike.toString(),
            oracleTimestampMs: String(oracleTimestampMs ?? 0),
            predictObjectId: PREDICT_BINARY_CONFIG.predictObjectId,
            quoteCoinType: PREDICT_BINARY_CONFIG.quoteCoinType,
            cachePolicy,
        }),
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) {
        throw new Error(`Preview API failed: ${response.status}`);
    }
    if (typeof payload !== "object" || payload === null || !("ok" in payload)) {
        throw new Error("Invalid preview API response");
    }
    const result = payload as BinaryPreviewApiResponse;
    return {
        previewKey: result.previewKey,
        cacheHit: result.cacheHit,
        up: previewFromApiSide(result.up),
        down: previewFromApiSide(result.down),
    };
}

const PREVIEW_DEBOUNCE_MS = 750;
const PREVIEW_POLL_INTERVAL_MS = 5_000;

function createMarketFromRound(roundMarket: PredictRoundMarket | null): BtcBinaryMarket | null {
    if (!roundMarket?.currentOracle || !roundMarket.round) {
        return null;
    }
    return {
        oracleId: roundMarket.currentOracle.oracleId,
        expiryMs: roundMarket.currentOracle.expiryMs,
        strike: BigInt(roundMarket.round.binaryStrikeRaw),
    };
}

export function usePredictBinary(
    roundMarket: PredictRoundMarket | null,
    spotTimestampMs: number | null,
) {
    const account = useCurrentAccount();
    const network = useCurrentNetwork();
    const client = useCurrentClient();
    const dAppKit = useDAppKit();
    const redeemingRef = useRef<string | null>(null);
    const previewRequestRef = useRef(0);
    const sidePositionRestoreRef = useRef(0);
    const loggedPreviewErrorsRef = useRef<Set<string>>(new Set());
    const previewKeyRef = useRef<string | null>(null);
    const previewContextRef = useRef<{
        oracleTimestampMs: number | null;
        spotTimestampMs: number | null;
    }>({ oracleTimestampMs: null, spotTimestampMs: null });
    const hasSuccessfulPreviewRef = useRef(false);
    const [amount, setAmount] = useState("10");
    const [txStatus, setTxStatus] = useState<BinaryTxStatus>("READY");
    const [previewStatus, setPreviewStatus] = useState<BinaryPreviewStatus>("IDLE");
    const [message, setMessage] = useState("READY");
    const [walletBalance, setWalletBalance] = useState(0n);
    const [managerId, setManagerId] = useState<string | null>(null);
    const [managerBalance, setManagerBalance] = useState(0n);
    const [hasJoinedArena, setHasJoinedArena] = useState(false);
    const [market, setMarket] = useState<BtcBinaryMarket | null>(null);
    const [upPreview, setUpPreview] = useState<SidePreviewState>({
        status: "IDLE",
        preview: null,
        error: null,
        debug: null,
        previewKey: null,
    });
    const [downPreview, setDownPreview] = useState<SidePreviewState>({
        status: "IDLE",
        preview: null,
        error: null,
        debug: null,
        previewKey: null,
    });
    const [position, setPosition] = useState<BinaryPositionState | null>(null);
    const [sidePositions, setSidePositions] = useState<BinarySidePositions>(emptySidePositions);
    const [lastMint, setLastMint] = useState<MintEvent | null>(null);
    const [lastEntryOdds, setLastEntryOdds] = useState<string | null>(null);
    const [lastRedeem, setLastRedeem] = useState<RedeemEvent | null>(null);
    const [lastDigest, setLastDigest] = useState<string | null>(null);

    useEffect(() => {
        hasSuccessfulPreviewRef.current = Boolean(upPreview.preview || downPreview.preview);
    }, [upPreview.preview, downPreview.preview]);

    const address = account?.address ?? null;
    const isTestnet = network === PREDICT_BINARY_CONFIG.network;

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

    // address 変化時のみ manager ID を取得してキャッシュ。15秒ごとの refresh() では呼ばない
    useEffect(() => {
        if (!address || !isTestnet) {
            setManagerId(null);
            return;
        }
        void findPredictManager(address).then(setManagerId);
    }, [address, isTestnet]);

    const isBusy = txStatus === "CONFIRM IN WALLET" || txStatus === "SUBMITTING";
    const isBettingOpen = roundMarket?.state === "BETTING_OPEN";
    const oracleTimestampMs = roundMarket?.currentOracle?.timestampMs ?? null;

    // 入力(=目標掛け金)を、デポジット(maxTotalCost)が残高に収まる範囲へ自動的に引き下げる。
    // 残高未取得(capacity=0)の間はキャップせず、取得後に preview が再計算される。
    const capBudgetToDepositCapacity = useCallback(
        (rawBudget: bigint): bigint => {
            const capacity = walletBalance + managerBalance;
            if (rawBudget <= 0n || capacity <= 0n) {
                return rawBudget;
            }
            const maxStake = maxStakeWithinDeposit(capacity, PREDICT_BINARY_CONFIG.feeBps);
            return rawBudget < maxStake ? rawBudget : maxStake;
        },
        [walletBalance, managerBalance],
    );

    useEffect(() => {
        previewContextRef.current = { oracleTimestampMs, spotTimestampMs };
    }, [oracleTimestampMs, spotTimestampMs]);

    const refresh = useCallback(async () => {
        if (!address || !isTestnet) {
            setMarket(null);
            setPosition(null);
            setSidePositions(emptySidePositions());
            setMessage(
                !address ? "Wallet not connected" : "Please switch your wallet to Sui Testnet",
            );
            return;
        }

        const baseMarket = createMarketFromRound(roundMarket);
        if (!baseMarket) {
            setMarket(null);
            setSidePositions(emptySidePositions());
            setMessage(roundMarket?.message ?? "NO ACTIVE ROUND");
            return;
        }

        try {
            const nextWalletBalance = await readWalletQuoteBalance(client, address);
            setMarket({ ...baseMarket });
            setWalletBalance(nextWalletBalance);
            setManagerBalance(0n);
            if (!isBusy) {
                setTxStatus("READY");
                setMessage(isBettingOpen ? "BET NOW" : "BETTING CLOSED");
            }
        } catch (caught) {
            setMarket(null);
            setTxStatus("FAILED");
            setMessage(readErrorMessage(caught));
        }
    }, [address, client, isBettingOpen, isBusy, isTestnet, roundMarket]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const restoreSidePositions = useCallback(
        async (targetMarket: BtcBinaryMarket) => {
            if (!address || !isTestnet) {
                setSidePositions(emptySidePositions());
                return;
            }
            const requestId = sidePositionRestoreRef.current + 1;
            sidePositionRestoreRef.current = requestId;
            try {
                const events = await queryPositionMintedEvents({
                    trader: address,
                    predictId: PREDICT_BINARY_CONFIG.predictObjectId,
                    oracleId: targetMarket.oracleId,
                    expiryMs: targetMarket.expiryMs,
                    strike: targetMarket.strike,
                    quoteCoinType: PREDICT_BINARY_CONFIG.quoteCoinType,
                });
                if (sidePositionRestoreRef.current !== requestId) {
                    return;
                }
                setSidePositions(sidePositionsFromMintedEvents(events));
            } catch (caught) {
                if (sidePositionRestoreRef.current !== requestId) {
                    return;
                }
                console.warn("Binary PositionMinted history restore failed", {
                    walletAddress: address,
                    oracleId: targetMarket.oracleId,
                    expiryMs: targetMarket.expiryMs,
                    referenceStrikeRaw: targetMarket.strike.toString(),
                    error: readErrorMessage(caught),
                });
            }
        },
        [address, isTestnet],
    );

    useEffect(() => {
        if (!address || !isTestnet || !market) {
            setSidePositions(emptySidePositions());
            return;
        }
        void restoreSidePositions(market);
    }, [address, isTestnet, market, restoreSidePositions]);

    const runBinaryPreview = useCallback(
        async ({ force = false, silent = false }: { force?: boolean; silent?: boolean } = {}) => {
            const resetPreviews = (status: BinaryPreviewStatus) => {
                setUpPreview({ status, preview: null, error: null, debug: null, previewKey: null });
                setDownPreview({
                    status,
                    preview: null,
                    error: null,
                    debug: null,
                    previewKey: null,
                });
            };

            if (!address || !isTestnet || !isBettingOpen) {
                previewRequestRef.current += 1;
                previewKeyRef.current = null;
                setPreviewStatus("IDLE");
                resetPreviews("IDLE");
                return;
            }
            if (!market) {
                previewRequestRef.current += 1;
                previewKeyRef.current = null;
                setPreviewStatus("UNAVAILABLE");
                resetPreviews("UNAVAILABLE");
                return;
            }

            let budget: bigint;
            try {
                budget = parseTokenAmount(amount, PREDICT_BINARY_CONFIG.quoteDecimals).atomic;
            } catch {
                previewRequestRef.current += 1;
                const status = amount.trim().length === 0 ? "IDLE" : "UNAVAILABLE";
                setPreviewStatus(status);
                resetPreviews(status);
                return;
            }
            budget = capBudgetToDepositCapacity(budget);

            const previewKey = buildBinaryPreviewRequestKey({
                walletAddress: address,
                oracleId: market.oracleId,
                expiryMs: market.expiryMs,
                referenceStrikeRaw: market.strike,
                betAmountAtomic: budget,
            });
            if (!force && previewKeyRef.current === previewKey) {
                return;
            }
            previewKeyRef.current = previewKey;
            previewRequestRef.current += 1;
            const requestId = previewRequestRef.current;

            if (!silent) {
                setPreviewStatus("PREVIEWING");
                setUpPreview((current) => ({
                    ...current,
                    status: "PREVIEWING",
                    error: null,
                    previewKey: current.preview ? current.previewKey : previewKey,
                }));
                setDownPreview((current) => ({
                    ...current,
                    status: "PREVIEWING",
                    error: null,
                    previewKey: current.preview ? current.previewKey : previewKey,
                }));
            }

            const warnPreviewFailure = ({
                direction,
                error,
                debug,
            }: {
                direction: BinaryDirection;
                error: string;
                debug: BinaryPreviewDebug | null;
            }) => {
                const logKey = `${previewKey}:${direction}:${error}:${debug?.reason ?? "request"}`;
                if (loggedPreviewErrorsRef.current.has(logKey)) {
                    return;
                }
                loggedPreviewErrorsRef.current.add(logKey);
                console.warn("Binary odds preview unavailable", {
                    side: direction,
                    previewKey,
                    ok: false,
                    error,
                    reason: debug?.reason ?? null,
                    devInspectError: debug?.devInspectError ?? null,
                    moveAbortCode: debug?.moveAbortCode ?? null,
                    lastTriedQuantity: debug?.lastTriedQuantity ?? null,
                    lastMintCost: debug?.lastMintCost ?? null,
                    lastRedeemPayout: debug?.lastRedeemPayout ?? null,
                    returnValuesRaw: debug?.returnValuesRaw ?? null,
                });
            };

            let result: Awaited<ReturnType<typeof previewBinaryOddsViaApi>>;
            try {
                const previewContext = previewContextRef.current;
                result = await previewBinaryOddsViaApi({
                    address,
                    market,
                    budget,
                    oracleTimestampMs: previewContext.oracleTimestampMs,
                });
            } catch (caught) {
                if (previewRequestRef.current !== requestId) {
                    return;
                }
                const error = readErrorMessage(caught);
                setUpPreview((current) =>
                    current.preview
                        ? { ...current, status: "READY", error }
                        : silent
                          ? current
                          : {
                                status: "ERROR",
                                preview: null,
                                error,
                                debug: null,
                                previewKey,
                            },
                );
                setDownPreview((current) =>
                    current.preview
                        ? { ...current, status: "READY", error }
                        : silent
                          ? current
                          : {
                                status: "ERROR",
                                preview: null,
                                error,
                                debug: null,
                                previewKey,
                            },
                );
                if (!silent) {
                    setPreviewStatus(hasSuccessfulPreviewRef.current ? "READY" : "ERROR");
                }
                warnPreviewFailure({ direction: "UP", error, debug: null });
                warnPreviewFailure({ direction: "DOWN", error, debug: null });
                return;
            }
            if (previewRequestRef.current !== requestId) {
                return;
            }

            let hasReady = false;
            let hasError = false;
            const applySide = (direction: BinaryDirection, side: ParsedBinaryPreviewSide) => {
                if (side.preview) {
                    hasReady = true;
                    const next = {
                        status: "READY" as const,
                        preview: side.preview,
                        error: null,
                        debug: side.debug,
                        previewKey: result.previewKey,
                    };
                    if (direction === "UP") {
                        setUpPreview(next);
                    } else {
                        setDownPreview(next);
                    }
                    return;
                }
                hasError = true;
                const nextError = side.error ?? "Preview failed";
                const applyFailure = (current: SidePreviewState): SidePreviewState =>
                    current.preview && current.previewKey === result.previewKey
                        ? {
                              ...current,
                              status: "READY",
                              error: nextError,
                              debug: side.debug,
                          }
                        : silent
                          ? current
                          : {
                                status: "ERROR",
                                preview: null,
                                error: nextError,
                                debug: side.debug,
                                previewKey: result.previewKey,
                            };
                if (direction === "UP") {
                    setUpPreview(applyFailure);
                } else {
                    setDownPreview(applyFailure);
                }
                warnPreviewFailure({
                    direction,
                    error: nextError,
                    debug: side.debug,
                });
            };

            applySide("UP", result.up);
            applySide("DOWN", result.down);

            if (hasReady || (!silent && hasSuccessfulPreviewRef.current)) {
                setPreviewStatus("READY");
            } else if (!silent) {
                setPreviewStatus(hasError ? "ERROR" : "UNAVAILABLE");
            }
            const up = result.up.preview;
            const down = result.down.preview;
            if (up || down) {
                const previewContext = previewContextRef.current;
                console.info("Binary odds preview", {
                    oracleId: market.oracleId,
                    expiry: market.expiryMs,
                    referenceStrikeRaw: market.strike.toString(),
                    spotTimestampMs: previewContext.spotTimestampMs,
                    betAmount: amount,
                    upFirstTriedQuantity: up?.firstTriedQuantity.toString() ?? null,
                    upQuantity: up?.quantity.toString() ?? null,
                    upCost: up?.mintCost.toString() ?? null,
                    upPayout: up?.redeemPayout.toString() ?? null,
                    upOdds: up ? formatBinaryOddsFromQuantity(up.quantity, up.mintCost) : null,
                    downFirstTriedQuantity: down?.firstTriedQuantity.toString() ?? null,
                    downQuantity: down?.quantity.toString() ?? null,
                    downCost: down?.mintCost.toString() ?? null,
                    downPayout: down?.redeemPayout.toString() ?? null,
                    downOdds: down
                        ? formatBinaryOddsFromQuantity(down.quantity, down.mintCost)
                        : null,
                    previewKey: result.previewKey,
                    cacheHit: result.cacheHit,
                    previewTimestamp: Date.now(),
                });
            }
        },
        [address, amount, capBudgetToDepositCapacity, isBettingOpen, isTestnet, market],
    );

    useEffect(() => {
        const timeoutId = window.setTimeout(() => {
            void runBinaryPreview();
        }, PREVIEW_DEBOUNCE_MS);

        return () => window.clearTimeout(timeoutId);
    }, [runBinaryPreview]);

    useEffect(() => {
        if (!address || !isTestnet || !isBettingOpen || !market) {
            return;
        }
        const intervalId = window.setInterval(() => {
            void runBinaryPreview({ force: true, silent: true });
        }, PREVIEW_POLL_INTERVAL_MS);

        return () => window.clearInterval(intervalId);
    }, [address, isBettingOpen, isTestnet, market, runBinaryPreview]);

    const placeBet = useCallback(
        async (direction: BinaryDirection) => {
            if (!address || !isTestnet) {
                setTxStatus("FAILED");
                setMessage(
                    !address ? "Wallet not connected" : "Please switch your wallet to Sui Testnet",
                );
                return;
            }
            const lockedMarket = createMarketFromRound(roundMarket);
            if (!isBettingOpen || !lockedMarket) {
                setTxStatus("FAILED");
                setMessage("BETTING CLOSED");
                return;
            }

            let budget: bigint;
            try {
                budget = parseTokenAmount(amount, PREDICT_BINARY_CONFIG.quoteDecimals).atomic;
            } catch (caught) {
                setTxStatus("FAILED");
                setMessage(readErrorMessage(caught));
                return;
            }
            // 目標掛け金をデポジットが残高に収まる範囲へ自動引き下げ（preview と同一ロジック）。
            budget = capBudgetToDepositCapacity(budget);
            const expectedPreviewKey = buildPreviewApiKey({
                market: lockedMarket,
                budget,
            });
            const canTradeBase =
                Boolean(address) && isTestnet && isBettingOpen && Boolean(lockedMarket) && !isBusy;
            let loggedAvailability = false;
            const logAvailability = (availability: BetAvailability) => {
                if (loggedAvailability) {
                    return;
                }
                loggedAvailability = true;
                console.info("Binary bet availability", {
                    side: direction,
                    canBet: availability.canBet,
                    reason: availability.reason,
                    previewKey: availability.previewKey,
                    expectedPreviewKey: availability.expectedPreviewKey,
                    previewOk: availability.previewOk,
                    previewReason: availability.previewReason,
                    quantity: availability.quantity,
                    mintCost: availability.mintCost,
                    betAmountAtomic: budget.toString(),
                    oracleId: lockedMarket.oracleId,
                    expiry: lockedMarket.expiryMs,
                    referenceStrikeRaw: lockedMarket.strike.toString(),
                });
            };
            const currentPreviewState = direction === "UP" ? upPreview : downPreview;
            const initialAvailability = getBetAvailability({
                canTrade: canTradeBase,
                hasPositiveAmount: budget > 0n,
                state: currentPreviewState,
                expectedPreviewKey,
            });
            if (!initialAvailability.canBet) {
                logAvailability(initialAvailability);
                setTxStatus("FAILED");
                setMessage(initialAvailability.reason);
                return;
            }
            if (budget > walletBalance + managerBalance) {
                logAvailability(initialAvailability);
                setTxStatus("FAILED");
                setMessage("Insufficient DUSDC balance");
                return;
            }

            try {
                let freshPreviewResult: Awaited<ReturnType<typeof previewBinaryOddsViaApi>>;
                try {
                    freshPreviewResult = await previewBinaryOddsViaApi({
                        address,
                        market: lockedMarket,
                        budget,
                        oracleTimestampMs,
                        cachePolicy: "bypass",
                    });
                } catch (caught) {
                    const error = readErrorMessage(caught);
                    if (direction === "UP") {
                        setUpPreview((current) =>
                            current.preview
                                ? { ...current, status: "READY", error }
                                : {
                                      status: "ERROR",
                                      preview: null,
                                      error,
                                      debug: null,
                                      previewKey: null,
                                  },
                        );
                    } else {
                        setDownPreview((current) =>
                            current.preview
                                ? { ...current, status: "READY", error }
                                : {
                                      status: "ERROR",
                                      preview: null,
                                      error,
                                      debug: null,
                                      previewKey: null,
                                  },
                        );
                    }
                    const availability = getBetAvailability({
                        canTrade: canTradeBase,
                        hasPositiveAmount: budget > 0n,
                        state: {
                            status: "ERROR",
                            preview: null,
                            error,
                            debug: null,
                            previewKey: null,
                        },
                        expectedPreviewKey,
                    });
                    logAvailability(availability);
                    setTxStatus("FAILED");
                    setMessage(availability.reason);
                    return;
                }
                if (freshPreviewResult.previewKey !== expectedPreviewKey) {
                    if (direction === "UP") {
                        setUpPreview((current) =>
                            current.preview
                                ? { ...current, status: "READY", error: "Preview is stale" }
                                : {
                                      status: "ERROR",
                                      preview: null,
                                      error: "Preview is stale",
                                      debug: null,
                                      previewKey: freshPreviewResult.previewKey,
                                  },
                        );
                    } else {
                        setDownPreview((current) =>
                            current.preview
                                ? { ...current, status: "READY", error: "Preview is stale" }
                                : {
                                      status: "ERROR",
                                      preview: null,
                                      error: "Preview is stale",
                                      debug: null,
                                      previewKey: freshPreviewResult.previewKey,
                                  },
                        );
                    }
                    const availability = getBetAvailability({
                        canTrade: canTradeBase,
                        hasPositiveAmount: budget > 0n,
                        state: {
                            status: "ERROR",
                            preview: null,
                            error: "Preview is stale",
                            debug: null,
                            previewKey: freshPreviewResult.previewKey,
                        },
                        expectedPreviewKey,
                    });
                    logAvailability(availability);
                    setTxStatus("FAILED");
                    setMessage(availability.reason);
                    return;
                }
                const sidePreview =
                    direction === "UP" ? freshPreviewResult.up : freshPreviewResult.down;
                const freshPreviewState = {
                    status: sidePreview.preview ? ("READY" as const) : ("ERROR" as const),
                    preview: sidePreview.preview,
                    error: sidePreview.error,
                    debug: sidePreview.debug,
                    previewKey: freshPreviewResult.previewKey,
                };
                if (direction === "UP") {
                    setUpPreview(freshPreviewState);
                } else {
                    setDownPreview(freshPreviewState);
                }
                const freshAvailability = getBetAvailability({
                    canTrade: canTradeBase,
                    hasPositiveAmount: budget > 0n,
                    state: freshPreviewState,
                    expectedPreviewKey,
                });
                logAvailability(freshAvailability);
                if (!freshAvailability.canBet || !freshPreviewState.preview) {
                    setTxStatus("FAILED");
                    setMessage(freshAvailability.reason);
                    return;
                }
                const latestPreview = freshPreviewState.preview;
                if (latestPreview.quantity <= 0n) {
                    throw new Error("Preview failed: quantity is zero");
                }
                if (latestPreview.mintCost <= 0n) {
                    throw new Error("Preview failed: mint cost is zero");
                }
                if (latestPreview.mintCost > budget) {
                    throw new Error("Preview failed: mint cost exceeds bet amount");
                }
                console.info("Binary mint preflight preview via API", {
                    side: direction,
                    walletAddress: address,
                    currentOracleId: lockedMarket.oracleId,
                    oracleExpiryMs: lockedMarket.expiryMs,
                    oracleTimestampMs,
                    referenceStrikeRaw: lockedMarket.strike.toString(),
                    betAmountInput: amount,
                    betAmountAtomic: budget.toString(),
                    quantity: latestPreview.quantity.toString(),
                    mintCost: latestPreview.mintCost.toString(),
                    redeemPayout: latestPreview.redeemPayout.toString(),
                    liveOdds: formatBinaryOddsFromQuantity(
                        latestPreview.quantity,
                        latestPreview.mintCost,
                    ),
                    previewSource: "api",
                    previewKey: freshPreviewResult.previewKey,
                    cacheHit: freshPreviewResult.cacheHit,
                });

                let nextManagerId = managerId;

                if (!nextManagerId) {
                    const createMoveCalls = describeCreatePredictManagerMoveCalls();
                    setTxStatus("CONFIRM IN WALLET");
                    setMessage("CONFIRM IN WALLET");
                    console.info("Binary bet manager creation transaction", {
                        moveCalls: createMoveCalls,
                        walletAddress: address,
                        reason: "initial setup only; not counted as BET PLACED",
                    });
                    const createResult = await dAppKit.signAndExecuteTransaction({
                        transaction: createPredictManagerTransaction(address),
                    });
                    const createDigest = readDigest(createResult);
                    console.info("Binary bet manager creation submitted", {
                        txDigest: createDigest,
                        moveCalls: createMoveCalls,
                    });
                    const created = await client.core.waitForTransaction({
                        digest: createDigest,
                        timeout: 60_000,
                        include: { events: true, effects: true, balanceChanges: true },
                    });
                    requestPostTransactionBalanceRefresh("binary:create-manager-confirmed");
                    console.info("Binary bet manager creation confirmed", {
                        txDigest: createDigest,
                        effectsStatus: toConsoleValue(
                            readTransactionEffectField(created, "status"),
                        ),
                        gasUsed: toConsoleValue(readTransactionEffectField(created, "gasUsed")),
                        effects: toConsoleValue(readTransactionEffects(created)),
                        events: toConsoleValue(created.Transaction?.events),
                        balanceChanges: toConsoleValue(created.Transaction?.balanceChanges),
                        reason: "initial setup only; not counted as BET PLACED",
                    });
                    nextManagerId = readManagerCreatedEvent(created.Transaction?.events) ?? null;
                    if (!nextManagerId) {
                        throw new Error("PredictManager creation could not be confirmed");
                    }
                    saveCachedManagerId(address, nextManagerId);
                    setManagerId(nextManagerId);
                }

                const latestMarket = createMarketFromRound(roundMarket);
                if (
                    !latestMarket ||
                    latestMarket.oracleId !== lockedMarket.oracleId ||
                    latestMarket.expiryMs !== lockedMarket.expiryMs ||
                    latestMarket.strike !== lockedMarket.strike
                ) {
                    throw new Error("Round changed before wallet confirmation");
                }
                // Arena への参加登録が未完了の場合は先に join する
                let nextHasJoined = hasJoinedArena;
                if (!nextHasJoined && nextManagerId) {
                    // state が stale の可能性があるのでオンチェーンで再確認
                    nextHasJoined = await checkArenaPlayerJoined(address);
                    if (nextHasJoined) setHasJoinedArena(true);
                }
                if (!nextHasJoined && nextManagerId) {
                    setTxStatus("CONFIRM IN WALLET");
                    setMessage("CONFIRM IN WALLET (Arena Join)");
                    try {
                        const joinResult = await dAppKit.signAndExecuteTransaction({
                            transaction: createJoinArenaTransaction({
                                sender: address,
                                managerId: nextManagerId,
                            }),
                        });
                        const joinDigest = readDigest(joinResult);
                        await client.core.waitForTransaction({
                            digest: joinDigest,
                            timeout: 60_000,
                        });
                        setHasJoinedArena(true);
                        nextHasJoined = true;
                    } catch (joinError) {
                        // 既に参加済み (EAlreadyJoined = 3) の場合はそのまま続行
                        if (isArenaAlreadyJoinedError(joinError)) {
                            setHasJoinedArena(true);
                            nextHasJoined = true;
                        } else {
                            throw joinError;
                        }
                    }
                }

                const maxTotalCost = calcMaxTotalCost(
                    latestPreview.mintCost,
                    PREDICT_BINARY_CONFIG.feeBps,
                );
                const fee = calcFee(latestPreview.mintCost, PREDICT_BINARY_CONFIG.feeBps);
                const knownManagerBalance = nextManagerId ? managerBalance : 0n;
                const depositAmount =
                    maxTotalCost > knownManagerBalance ? maxTotalCost - knownManagerBalance : 0n;

                setMessage(
                    `Using ${formatTokenAmount(
                        latestPreview.mintCost + fee,
                        PREDICT_BINARY_CONFIG.quoteDecimals,
                    )} DUSDC (含む手数料 ${formatTokenAmount(fee, PREDICT_BINARY_CONFIG.quoteDecimals)})`,
                );
                const mintInput = {
                    sender: address,
                    managerId: nextManagerId,
                    oracleId: latestMarket.oracleId,
                    expiryMs: latestMarket.expiryMs,
                    strike: latestMarket.strike,
                    isUp: direction === "UP",
                    quantity: latestPreview.quantity,
                    depositAmount,
                    maxTotalCost,
                };
                const mintMoveCalls = describeMintBinaryMoveCalls(mintInput);
                console.info("Binary bet mint transaction before wallet approval", {
                    moveCalls: mintMoveCalls,
                    walletAddress: address,
                    managerId: nextManagerId,
                    side: direction,
                    oracleId: latestMarket.oracleId,
                    expiryMs: latestMarket.expiryMs,
                    referenceStrikeRaw: latestMarket.strike.toString(),
                    quantity: latestPreview.quantity.toString(),
                    mintCost: latestPreview.mintCost.toString(),
                    depositAmount: depositAmount.toString(),
                    knownManagerBalance: knownManagerBalance.toString(),
                    preWalletRpc: "skipped",
                    quoteCoinType: PREDICT_BINARY_CONFIG.quoteCoinType,
                });
                const tx = createMintBinaryTransaction(mintInput);

                setTxStatus("CONFIRM IN WALLET");
                setMessage("CONFIRM IN WALLET");
                const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
                const digest = readDigest(result);
                setTxStatus("SUBMITTING");
                setMessage("SUBMITTING");
                const executed = await client.core.waitForTransaction({
                    digest,
                    timeout: 60_000,
                    include: {
                        events: true,
                        effects: true,
                        balanceChanges: true,
                        transaction: true,
                    },
                });
                requestPostTransactionBalanceRefresh("binary:mint-transaction-confirmed");
                const executedEvents = readTransactionEvents(executed);
                console.info("Binary bet mint transaction confirmed", {
                    txDigest: digest,
                    effectsStatus: toConsoleValue(readTransactionEffectField(executed, "status")),
                    gasUsed: toConsoleValue(readTransactionEffectField(executed, "gasUsed")),
                    effects: toConsoleValue(readTransactionEffects(executed)),
                    transaction: toConsoleValue(executed.Transaction?.transaction),
                    events: toConsoleValue(executedEvents),
                    balanceChanges: toConsoleValue(executed.Transaction?.balanceChanges),
                    moveCalls: mintMoveCalls,
                });
                let mint: MintEvent;
                const rawMintEvent = findMintEvent(executedEvents);
                try {
                    mint = readMintEvent(executedEvents);
                } catch (caught) {
                    logPositionMintedEventDetails(rawMintEvent, null);
                    console.warn("Binary PositionMinted event was not found", {
                        expectedEventType: POSITION_MINTED_EVENT_TYPE,
                        eventTypes: executedEvents.map((event) =>
                            isRecord(event) ? (event.eventType ?? event.type ?? null) : null,
                        ),
                    });
                    throw new BetValidationError("No position was minted", {
                        reason: readErrorMessage(caught),
                        txDigest: digest,
                        events: toConsoleValue(executedEvents),
                        moveCalls: mintMoveCalls,
                    });
                }
                logPositionMintedEventDetails(rawMintEvent, mint);
                if (
                    mint.predictId !== PREDICT_BINARY_CONFIG.predictObjectId ||
                    mint.managerId !== nextManagerId ||
                    mint.oracleId !== latestMarket.oracleId ||
                    mint.expiryMs !== latestMarket.expiryMs ||
                    mint.strike !== latestMarket.strike ||
                    mint.isUp !== (direction === "UP") ||
                    mint.quantity <= 0n ||
                    mint.cost <= 0n
                ) {
                    throw new BetValidationError("No position was minted", {
                        reason: "PositionMinted event did not match the locked bet",
                        expected: {
                            predictId: PREDICT_BINARY_CONFIG.predictObjectId,
                            managerId: nextManagerId,
                            oracleId: latestMarket.oracleId,
                            expiryMs: latestMarket.expiryMs,
                            strike: latestMarket.strike.toString(),
                            isUp: direction === "UP",
                        },
                        actual: toConsoleValue(mint),
                        txDigest: digest,
                    });
                }
                console.info("Binary bet minted", {
                    txDigest: digest,
                    positionMintedEvent: toConsoleValue(mint),
                    entryOdds: formatBinaryOddsFromQuantity(mint.quantity, mint.cost),
                });
                setLastMint(mint);
                const mintedPosition = positionFromMintEvent(mint, digest);
                const entryOdds = mintedPosition.entryOdds;
                setLastEntryOdds(entryOdds);
                setLastDigest(digest);
                setPosition(mintedPosition);
                await restoreSidePositions(latestMarket);
                setTxStatus("BET PLACED");
                setMessage("BET PLACED");
                await refresh();
            } catch (caught) {
                if (isWalletUserRejection(caught)) {
                    console.info(
                        "Binary mint transaction cancelled",
                        readWalletCancellationDebug(caught),
                    );
                    setTxStatus("READY");
                    setMessage("Transaction cancelled");
                    return;
                }
                const errorMessage = readErrorMessage(caught);
                if (errorMessage.startsWith("Preview")) {
                    console.warn("Binary mint preview failed", {
                        side: direction,
                        ok: false,
                        error: "Preview failed",
                        reason: errorMessage,
                    });
                    setTxStatus("FAILED");
                    setMessage("Odds unavailable. Please refresh or wait.");
                    return;
                }
                requestPostTransactionBalanceRefresh("binary:mint-failed");
                console.error("Binary mint failed:", caught);
                setTxStatus("FAILED");
                setMessage(
                    caught instanceof BetValidationError
                        ? `BET FAILED: ${caught.message}`
                        : readErrorMessage(caught),
                );
            }
        },
        [
            address,
            amount,
            capBudgetToDepositCapacity,
            client,
            dAppKit,
            hasJoinedArena,
            isBettingOpen,
            isBusy,
            isTestnet,
            managerBalance,
            managerId,
            oracleTimestampMs,
            refresh,
            restoreSidePositions,
            roundMarket,
            upPreview,
            downPreview,
            walletBalance,
        ],
    );

    useEffect(() => {
        if (!address || !isTestnet || !managerId || !market || !position) {
            return;
        }
        if (Date.now() < position.expiryMs) {
            return;
        }
        const redeemKey = `${managerId}:${position.oracleId}:${position.strike}:${position.direction}:${position.quantity}`;
        if (redeemingRef.current === redeemKey) {
            return;
        }

        redeemingRef.current = redeemKey;
        void (async () => {
            try {
                setMessage("CONFIRM IN WALLET");
                const tx = createRedeemBinaryTransaction({
                    sender: address,
                    managerId,
                    oracleId: position.oracleId,
                    expiryMs: position.expiryMs,
                    strike: position.strike,
                    isUp: position.direction === "UP",
                    quantity: position.quantity,
                });
                const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
                const digest = readDigest(result);
                const executed = await client.core.waitForTransaction({
                    digest,
                    timeout: 60_000,
                    include: { events: true },
                });
                const redeemed = readRedeemEvent(executed.Transaction?.events);
                setLastRedeem(redeemed);
                setLastDigest(digest);
                setTxStatus(redeemed.payout > 0n ? "WON" : "LOST");
                setMessage(redeemed.payout > 0n ? "WON" : "LOST");
                setPosition(null);
                await refresh();
            } catch (caught) {
                redeemingRef.current = null;
                if (isWalletUserRejection(caught)) {
                    console.info(
                        "Binary redeem transaction cancelled",
                        readWalletCancellationDebug(caught),
                    );
                    setTxStatus("READY");
                    setMessage("Transaction cancelled");
                    return;
                }
                console.error("Binary redeem failed:", caught);
                setTxStatus("FAILED");
                setMessage(readErrorMessage(caught));
            }
        })();
    }, [address, client, dAppKit, isTestnet, managerId, market, position, refresh]);

    return useMemo(() => {
        const canTradeBase =
            Boolean(address) && isTestnet && isBettingOpen && Boolean(market) && !isBusy;
        const oddsClosedLabel = roundMarket?.state === "FINAL_LIVE" ? "Round Locked" : null;
        const oddsCalculatingLabel =
            roundMarket?.state === "LOCKING_ROUND" ? "Calculating..." : null;
        let currentBetPreviewKey: string | null = null;
        let hasPositiveAmount = false;
        try {
            const budget = parseTokenAmount(amount, PREDICT_BINARY_CONFIG.quoteDecimals).atomic;
            hasPositiveAmount = budget > 0n;
            if (market && hasPositiveAmount) {
                currentBetPreviewKey = buildPreviewApiKey({
                    market,
                    budget,
                });
            }
        } catch {
            currentBetPreviewKey = null;
            hasPositiveAmount = false;
        }
        const upAvailability = getBetAvailability({
            canTrade: canTradeBase,
            hasPositiveAmount,
            state: upPreview,
            expectedPreviewKey: currentBetPreviewKey,
        });
        const downAvailability = getBetAvailability({
            canTrade: canTradeBase,
            hasPositiveAmount,
            state: downPreview,
            expectedPreviewKey: currentBetPreviewKey,
        });
        const formatSideOdds = (state: SidePreviewState): string => {
            if (state.preview) {
                return formatBinaryOddsFromQuantity(state.preview.quantity, state.preview.mintCost);
            }
            if (oddsClosedLabel) {
                return oddsClosedLabel;
            }
            if (oddsCalculatingLabel) {
                return oddsCalculatingLabel;
            }
            if (state.status === "PREVIEWING") {
                return "Calculating...";
            }
            if (state.status === "ERROR") {
                return "Odds unavailable";
            }
            return "--";
        };
        return {
            amount,
            setAmount,
            txStatus,
            message,
            isBusy,
            canTrade: canTradeBase,
            canBetUp: upAvailability.canBet,
            canBetDown: downAvailability.canBet,
            oddsUnavailableLabel:
                hasPositiveAmount && previewStatus === "ERROR"
                    ? "Odds unavailable. Please wait or refresh."
                    : null,
            position,
            lastMint,
            lastRedeem,
            lastEntryOdds,
            previewStatus,
            upOdds: formatSideOdds(upPreview),
            downOdds: formatSideOdds(downPreview),
            costLabel: lastMint
                ? `${formatTokenAmount(lastMint.cost, PREDICT_BINARY_CONFIG.quoteDecimals)} DUSDC`
                : null,
            entryOddsLabel: position?.entryOdds ?? null,
            settledEntryOddsLabel:
                position?.entryOdds ??
                lastEntryOdds ??
                (lastMint ? formatBinaryOddsFromQuantity(lastMint.quantity, lastMint.cost) : null),
            entryCostLabel:
                position && position.cost > 0n
                    ? `${formatTokenAmount(position.cost, PREDICT_BINARY_CONFIG.quoteDecimals)} DUSDC`
                    : null,
            sidePositionLabels: {
                UP:
                    sidePositions.UP && sidePositions.UP.cost > 0n
                        ? {
                              bet: `${formatTokenAmount(
                                  sidePositions.UP.cost,
                                  PREDICT_BINARY_CONFIG.quoteDecimals,
                              )} DUSDC`,
                              entryOdds: sidePositions.UP.entryOdds,
                          }
                        : null,
                DOWN:
                    sidePositions.DOWN && sidePositions.DOWN.cost > 0n
                        ? {
                              bet: `${formatTokenAmount(
                                  sidePositions.DOWN.cost,
                                  PREDICT_BINARY_CONFIG.quoteDecimals,
                              )} DUSDC`,
                              entryOdds: sidePositions.DOWN.entryOdds,
                          }
                        : null,
            },
            payoutLabel: lastRedeem
                ? `${formatTokenAmount(lastRedeem.payout, PREDICT_BINARY_CONFIG.quoteDecimals)} DUSDC`
                : null,
            explorerUrl: lastDigest ? predictBinaryExplorerUrl(lastDigest) : null,
            feeBpsLabel: `FEE ${PREDICT_BINARY_CONFIG.feeBps / 100}%`,
            walletBalanceLabel:
                walletBalance > 0n
                    ? formatTokenAmount(walletBalance, PREDICT_BINARY_CONFIG.quoteDecimals)
                    : null,
            activeBetSummary: (() => {
                const parts: string[] = [];
                if (sidePositions.UP && sidePositions.UP.cost > 0n) {
                    parts.push(
                        `UP ${formatTokenAmount(sidePositions.UP.cost, PREDICT_BINARY_CONFIG.quoteDecimals)}`,
                    );
                }
                if (sidePositions.DOWN && sidePositions.DOWN.cost > 0n) {
                    parts.push(
                        `DOWN ${formatTokenAmount(sidePositions.DOWN.cost, PREDICT_BINARY_CONFIG.quoteDecimals)}`,
                    );
                }
                return parts.length > 0 ? parts.join(", ") : null;
            })(),
            placeBet,
        };
    }, [
        address,
        amount,
        isBettingOpen,
        isBusy,
        isTestnet,
        lastDigest,
        lastEntryOdds,
        lastMint,
        lastRedeem,
        market,
        message,
        placeBet,
        position,
        previewStatus,
        roundMarket?.state,
        sidePositions,
        txStatus,
        upPreview,
        downPreview,
        walletBalance,
    ]);
}
