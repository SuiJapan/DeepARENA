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
    type BtcBinaryMarket,
    type BudgetedTradePreview,
    findMintEvent,
    findPredictManager,
    type MintEvent,
    type RedeemEvent,
    readBinaryPosition,
    readDigest,
    readManagerBalance,
    readManagerCreatedEvent,
    readMintEvent,
    readRedeemEvent,
    readWalletQuoteBalance,
} from "@/src/lib/predict-binary/client";
import { PREDICT_BINARY_CONFIG, predictBinaryExplorerUrl } from "@/src/lib/predict-binary/config";
import { readSuiEventPayloads } from "@/src/lib/predict-binary/events";
import { formatBinaryOddsFromQuantity } from "@/src/lib/predict-binary/odds";
import {
    createMintBinaryTransaction,
    createPredictManagerTransaction,
    createRedeemBinaryTransaction,
    describeCreatePredictManagerMoveCalls,
    describeMintBinaryMoveCalls,
} from "@/src/lib/predict-binary/transactions";

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

interface ParsedBinaryPreviewSide {
    ok: boolean;
    preview: BudgetedTradePreview | null;
    error: string | null;
    debug: BinaryPreviewDebug;
}

class BinaryMintPreviewError extends Error {
    constructor(
        message: string,
        readonly details: {
            side: BinaryDirection;
            previewKey: string | null;
            debug: BinaryPreviewDebug | null;
        },
    ) {
        super(message);
        this.name = "BinaryMintPreviewError";
    }
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

function selectPreviewSide(
    result: Awaited<ReturnType<typeof previewBinaryOddsViaApi>>,
    direction: BinaryDirection,
): BudgetedTradePreview {
    const side = direction === "UP" ? result.up : result.down;
    if (side.preview) {
        return side.preview;
    }
    throw new BinaryMintPreviewError("Preview failed", {
        side: direction,
        previewKey: result.previewKey,
        debug: side.debug,
    });
}

async function previewBinaryOddsViaApi({
    address,
    market,
    budget,
    oracleTimestampMs,
}: {
    address: string;
    market: BtcBinaryMarket;
    budget: bigint;
    oracleTimestampMs: number | null;
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
    const loggedPreviewErrorsRef = useRef<Set<string>>(new Set());
    const previewKeyRef = useRef<string | null>(null);
    const [amount, setAmount] = useState("");
    const [txStatus, setTxStatus] = useState<BinaryTxStatus>("READY");
    const [previewStatus, setPreviewStatus] = useState<BinaryPreviewStatus>("IDLE");
    const [message, setMessage] = useState("READY");
    const [walletBalance, setWalletBalance] = useState(0n);
    const [managerId, setManagerId] = useState<string | null>(null);
    const [managerBalance, setManagerBalance] = useState(0n);
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
    const [lastMint, setLastMint] = useState<MintEvent | null>(null);
    const [lastEntryOdds, setLastEntryOdds] = useState<string | null>(null);
    const [lastRedeem, setLastRedeem] = useState<RedeemEvent | null>(null);
    const [lastDigest, setLastDigest] = useState<string | null>(null);

    const address = account?.address ?? null;
    const isTestnet = network === PREDICT_BINARY_CONFIG.network;
    const isBusy = txStatus === "CONFIRM IN WALLET" || txStatus === "SUBMITTING";
    const isBettingOpen = roundMarket?.state === "BETTING_OPEN";
    const oracleTimestampMs = roundMarket?.currentOracle?.timestampMs ?? null;

    const refresh = useCallback(async () => {
        if (!address || !isTestnet) {
            setMarket(null);
            setManagerId(null);
            setPosition(null);
            setMessage(
                !address ? "Wallet not connected" : "Please switch your wallet to Sui Testnet",
            );
            return;
        }

        const baseMarket = createMarketFromRound(roundMarket);
        if (!baseMarket) {
            setMarket(null);
            setMessage(roundMarket?.message ?? "NO ACTIVE ROUND");
            return;
        }

        try {
            const [nextWalletBalance, foundManagerId] = await Promise.all([
                readWalletQuoteBalance(client, address),
                findPredictManager(address),
            ]);
            const nextMarket = { ...baseMarket };
            setMarket(nextMarket);
            setWalletBalance(nextWalletBalance);
            setManagerId(foundManagerId);

            if (foundManagerId) {
                const [nextManagerBalance, upPosition, downPosition] = await Promise.all([
                    readManagerBalance(client, address, foundManagerId),
                    readBinaryPosition(client, {
                        sender: address,
                        managerId: foundManagerId,
                        oracleId: nextMarket.oracleId,
                        expiryMs: nextMarket.expiryMs,
                        strike: nextMarket.strike,
                        isUp: true,
                    }),
                    readBinaryPosition(client, {
                        sender: address,
                        managerId: foundManagerId,
                        oracleId: nextMarket.oracleId,
                        expiryMs: nextMarket.expiryMs,
                        strike: nextMarket.strike,
                        isUp: false,
                    }),
                ]);
                setManagerBalance(nextManagerBalance);
                const activePosition =
                    upPosition > 0n
                        ? { direction: "UP" as const, quantity: upPosition }
                        : downPosition > 0n
                          ? { direction: "DOWN" as const, quantity: downPosition }
                          : null;
                if (activePosition) {
                    setPosition((current) => {
                        if (
                            current &&
                            current.direction === activePosition.direction &&
                            current.quantity === activePosition.quantity &&
                            current.strike === nextMarket.strike &&
                            current.expiryMs === nextMarket.expiryMs &&
                            current.oracleId === nextMarket.oracleId
                        ) {
                            return current;
                        }
                        return {
                            direction: activePosition.direction,
                            quantity: activePosition.quantity,
                            cost: 0n,
                            payout: null,
                            entryOdds: null,
                            strike: nextMarket.strike,
                            expiryMs: nextMarket.expiryMs,
                            oracleId: nextMarket.oracleId,
                        };
                    });
                } else {
                    setPosition(null);
                }
            } else {
                setManagerBalance(0n);
                setPosition(null);
            }
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

    useEffect(() => {
        previewRequestRef.current += 1;
        const requestId = previewRequestRef.current;
        const resetPreviews = (status: BinaryPreviewStatus) => {
            setUpPreview({ status, preview: null, error: null, debug: null, previewKey: null });
            setDownPreview({ status, preview: null, error: null, debug: null, previewKey: null });
        };

        if (!address || !isTestnet || !isBettingOpen) {
            previewKeyRef.current = null;
            setPreviewStatus("IDLE");
            resetPreviews("IDLE");
            return;
        }
        if (!market) {
            previewKeyRef.current = null;
            setPreviewStatus("UNAVAILABLE");
            resetPreviews("UNAVAILABLE");
            return;
        }

        let budget: bigint;
        try {
            budget = parseTokenAmount(amount, PREDICT_BINARY_CONFIG.quoteDecimals).atomic;
        } catch {
            setPreviewStatus(amount.trim().length === 0 ? "IDLE" : "UNAVAILABLE");
            resetPreviews(amount.trim().length === 0 ? "IDLE" : "UNAVAILABLE");
            return;
        }

        const previewKey = [
            address,
            market.oracleId,
            market.expiryMs,
            market.strike.toString(),
            spotTimestampMs ?? "no-spot",
            budget.toString(),
        ].join(":");
        if (previewKeyRef.current === previewKey) {
            return;
        }
        previewKeyRef.current = previewKey;

        setPreviewStatus("PREVIEWING");
        setUpPreview((current) => ({ ...current, status: "PREVIEWING" }));
        setDownPreview((current) => ({ ...current, status: "PREVIEWING" }));
        const timeoutId = window.setTimeout(() => {
            void (async () => {
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
                    result = await previewBinaryOddsViaApi({
                        address,
                        market,
                        budget,
                        oracleTimestampMs,
                    });
                } catch (caught) {
                    if (previewRequestRef.current !== requestId) {
                        return;
                    }
                    const error = readErrorMessage(caught);
                    setUpPreview((current) => ({
                        ...current,
                        status: current.preview ? "READY" : "ERROR",
                        error,
                        debug: null,
                        previewKey,
                    }));
                    setDownPreview((current) => ({
                        ...current,
                        status: current.preview ? "READY" : "ERROR",
                        error,
                        debug: null,
                        previewKey,
                    }));
                    setPreviewStatus("ERROR");
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
                    if (direction === "UP") {
                        setUpPreview((current) => ({
                            ...current,
                            status: current.preview ? "READY" : "ERROR",
                            error: side.error ?? "Preview failed",
                            debug: side.debug,
                            previewKey: result.previewKey,
                        }));
                    } else {
                        setDownPreview((current) => ({
                            ...current,
                            status: current.preview ? "READY" : "ERROR",
                            error: side.error ?? "Preview failed",
                            debug: side.debug,
                            previewKey: result.previewKey,
                        }));
                    }
                    warnPreviewFailure({
                        direction,
                        error: side.error ?? "Preview failed",
                        debug: side.debug,
                    });
                };

                applySide("UP", result.up);
                applySide("DOWN", result.down);

                setPreviewStatus(hasReady ? "READY" : hasError ? "ERROR" : "UNAVAILABLE");
                const up = result.up.preview;
                const down = result.down.preview;
                if (up || down) {
                    console.info("Binary odds preview", {
                        oracleId: market.oracleId,
                        expiry: market.expiryMs,
                        referenceStrikeRaw: market.strike.toString(),
                        spotTimestampMs,
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
                if (hasError && !hasReady) {
                    if (previewRequestRef.current !== requestId) {
                        return;
                    }
                    setPreviewStatus("ERROR");
                }
            })();
        }, 750);

        return () => window.clearTimeout(timeoutId);
    }, [address, amount, isBettingOpen, isTestnet, market, oracleTimestampMs, spotTimestampMs]);

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
            if (budget > walletBalance + managerBalance) {
                setTxStatus("FAILED");
                setMessage("Insufficient DUSDC balance");
                return;
            }

            try {
                const freshPreviewResult = await previewBinaryOddsViaApi({
                    address,
                    market: lockedMarket,
                    budget,
                    oracleTimestampMs,
                });
                const latestPreview = selectPreviewSide(freshPreviewResult, direction);
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
                    previewKey: freshPreviewResult.previewKey,
                    cacheHit: freshPreviewResult.cacheHit,
                });

                let nextManagerId = managerId;
                const walletBalanceBefore = await readWalletQuoteBalance(client, address);
                const initialManagerBalance = nextManagerId
                    ? await readManagerBalance(client, address, nextManagerId)
                    : 0n;
                const initialPosition = nextManagerId
                    ? await readBinaryPosition(client, {
                          sender: address,
                          managerId: nextManagerId,
                          oracleId: lockedMarket.oracleId,
                          expiryMs: lockedMarket.expiryMs,
                          strike: lockedMarket.strike,
                          isUp: direction === "UP",
                      })
                    : 0n;

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
                    setManagerId(nextManagerId);
                }

                const latestManagerBalance = await readManagerBalance(
                    client,
                    address,
                    nextManagerId,
                );
                const latestMarket = createMarketFromRound(roundMarket);
                if (
                    !latestMarket ||
                    latestMarket.oracleId !== lockedMarket.oracleId ||
                    latestMarket.expiryMs !== lockedMarket.expiryMs ||
                    latestMarket.strike !== lockedMarket.strike
                ) {
                    throw new Error("Round changed before wallet confirmation");
                }
                const depositAmount =
                    latestPreview.mintCost > latestManagerBalance
                        ? latestPreview.mintCost - latestManagerBalance
                        : 0n;

                const positionBefore = await readBinaryPosition(client, {
                    sender: address,
                    managerId: nextManagerId,
                    oracleId: latestMarket.oracleId,
                    expiryMs: latestMarket.expiryMs,
                    strike: latestMarket.strike,
                    isUp: direction === "UP",
                });
                setMessage(
                    `Using ${formatTokenAmount(
                        latestPreview.mintCost,
                        PREDICT_BINARY_CONFIG.quoteDecimals,
                    )} DUSDC`,
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
                    walletBalanceBefore: walletBalanceBefore.toString(),
                    managerBalanceBefore: latestManagerBalance.toString(),
                    positionBefore: positionBefore.toString(),
                    initialManagerBalance: initialManagerBalance.toString(),
                    initialPosition: initialPosition.toString(),
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
                console.info("Binary bet mint transaction confirmed", {
                    txDigest: digest,
                    effectsStatus: toConsoleValue(readTransactionEffectField(executed, "status")),
                    gasUsed: toConsoleValue(readTransactionEffectField(executed, "gasUsed")),
                    effects: toConsoleValue(readTransactionEffects(executed)),
                    transaction: toConsoleValue(executed.Transaction?.transaction),
                    events: toConsoleValue(executed.Transaction?.events),
                    balanceChanges: toConsoleValue(executed.Transaction?.balanceChanges),
                    moveCalls: mintMoveCalls,
                });
                let mint: MintEvent;
                const rawMintEvent = findMintEvent(executed.Transaction?.events);
                try {
                    mint = readMintEvent(executed.Transaction?.events);
                } catch (caught) {
                    logPositionMintedEventDetails(rawMintEvent, null);
                    const [
                        walletBalanceAfterNoMint,
                        managerBalanceAfterNoMint,
                        positionAfterNoMint,
                    ] = await Promise.all([
                        readWalletQuoteBalance(client, address),
                        readManagerBalance(client, address, nextManagerId),
                        readBinaryPosition(client, {
                            sender: address,
                            managerId: nextManagerId,
                            oracleId: latestMarket.oracleId,
                            expiryMs: latestMarket.expiryMs,
                            strike: latestMarket.strike,
                            isUp: direction === "UP",
                        }),
                    ]);
                    if (
                        walletBalanceAfterNoMint !== walletBalanceBefore ||
                        managerBalanceAfterNoMint !== latestManagerBalance
                    ) {
                        console.warn("Deposit succeeded but mint position was not confirmed", {
                            txDigest: digest,
                            managerBalanceAfter: managerBalanceAfterNoMint.toString(),
                            walletBalanceAfter: walletBalanceAfterNoMint.toString(),
                            walletBalanceBefore: walletBalanceBefore.toString(),
                            managerBalanceBefore: latestManagerBalance.toString(),
                            positionBefore: positionBefore.toString(),
                            positionAfter: positionAfterNoMint.toString(),
                        });
                    }
                    throw new BetValidationError("No position was minted", {
                        reason: readErrorMessage(caught),
                        txDigest: digest,
                        events: toConsoleValue(executed.Transaction?.events),
                        moveCalls: mintMoveCalls,
                    });
                }
                logPositionMintedEventDetails(rawMintEvent, mint);
                if (
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
                const [walletBalanceAfter, managerBalanceAfter, positionAfter] = await Promise.all([
                    readWalletQuoteBalance(client, address),
                    readManagerBalance(client, address, nextManagerId),
                    readBinaryPosition(client, {
                        sender: address,
                        managerId: nextManagerId,
                        oracleId: latestMarket.oracleId,
                        expiryMs: latestMarket.expiryMs,
                        strike: latestMarket.strike,
                        isUp: direction === "UP",
                    }),
                ]);
                const positionDelta = positionAfter - positionBefore;
                console.info("Binary post-mint position refresh", {
                    txDigest: digest,
                    positionBefore: positionBefore.toString(),
                    positionAfter: positionAfter.toString(),
                    positionDelta: positionDelta.toString(),
                });
                if (positionAfter < positionBefore + mint.quantity) {
                    console.warn("Binary position query lagged behind PositionMinted event", {
                        txDigest: digest,
                        reason: "PredictManager position did not increase by minted quantity",
                        positionBefore: positionBefore.toString(),
                        positionAfter: positionAfter.toString(),
                        mintedQuantity: mint.quantity.toString(),
                    });
                }
                if (
                    walletBalanceAfter === walletBalanceBefore &&
                    managerBalanceAfter === latestManagerBalance
                ) {
                    console.warn("Binary balances did not change after PositionMinted event", {
                        txDigest: digest,
                        reason: "DUSDC wallet and manager balances did not change",
                        walletBalanceBefore: walletBalanceBefore.toString(),
                        walletBalanceAfter: walletBalanceAfter.toString(),
                        managerBalanceBefore: latestManagerBalance.toString(),
                        managerBalanceAfter: managerBalanceAfter.toString(),
                    });
                }
                console.info("Binary bet minted", {
                    txDigest: digest,
                    positionMintedEvent: toConsoleValue(mint),
                    walletBalanceBefore: walletBalanceBefore.toString(),
                    walletBalanceAfter: walletBalanceAfter.toString(),
                    managerBalanceBefore: latestManagerBalance.toString(),
                    managerBalanceAfter: managerBalanceAfter.toString(),
                    positionBefore: positionBefore.toString(),
                    positionAfter: positionAfter.toString(),
                    entryOdds: formatBinaryOddsFromQuantity(mint.quantity, mint.cost),
                });
                setLastMint(mint);
                const entryOdds = formatBinaryOddsFromQuantity(mint.quantity, mint.cost);
                setLastEntryOdds(entryOdds);
                setLastDigest(digest);
                setPosition({
                    direction: directionFromBool(mint.isUp),
                    quantity: mint.quantity,
                    cost: mint.cost,
                    payout: null,
                    entryOdds,
                    strike: mint.strike,
                    expiryMs: mint.expiryMs,
                    oracleId: mint.oracleId,
                    digest,
                });
                setTxStatus("BET PLACED");
                setMessage("BET PLACED");
                await refresh();
            } catch (caught) {
                const errorMessage = readErrorMessage(caught);
                if (
                    caught instanceof BinaryMintPreviewError ||
                    errorMessage.startsWith("Preview")
                ) {
                    const debug =
                        caught instanceof BinaryMintPreviewError ? caught.details.debug : null;
                    console.warn("Binary mint preview failed", {
                        side:
                            caught instanceof BinaryMintPreviewError
                                ? caught.details.side
                                : direction,
                        previewKey:
                            caught instanceof BinaryMintPreviewError
                                ? caught.details.previewKey
                                : null,
                        ok: false,
                        error: "Preview failed",
                        reason: debug?.reason ?? null,
                        devInspectError: debug?.devInspectError ?? errorMessage,
                        moveAbortCode: debug?.moveAbortCode ?? null,
                        lastTriedQuantity: debug?.lastTriedQuantity ?? null,
                        lastMintCost: debug?.lastMintCost ?? null,
                        lastRedeemPayout: debug?.lastRedeemPayout ?? null,
                        returnValuesRaw: debug?.returnValuesRaw ?? null,
                    });
                    setTxStatus("FAILED");
                    setMessage("Preview failed");
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
            client,
            dAppKit,
            isBettingOpen,
            isTestnet,
            managerBalance,
            managerId,
            oracleTimestampMs,
            refresh,
            roundMarket,
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
                console.error("Binary redeem failed:", caught);
                redeemingRef.current = null;
                setTxStatus("FAILED");
                setMessage(readErrorMessage(caught));
            }
        })();
    }, [address, client, dAppKit, isTestnet, managerId, market, position, refresh]);

    return useMemo(
        () => ({
            amount,
            setAmount,
            txStatus,
            message,
            isBusy,
            canTrade: Boolean(address) && isTestnet && isBettingOpen && Boolean(market) && !isBusy,
            position,
            lastMint,
            lastRedeem,
            lastEntryOdds,
            previewStatus,
            upOdds: upPreview.preview
                ? formatBinaryOddsFromQuantity(
                      upPreview.preview.quantity,
                      upPreview.preview.mintCost,
                  )
                : upPreview.status === "PREVIEWING"
                  ? "Calculating..."
                  : upPreview.status === "ERROR"
                    ? "Odds unavailable"
                    : "--",
            downOdds: downPreview.preview
                ? formatBinaryOddsFromQuantity(
                      downPreview.preview.quantity,
                      downPreview.preview.mintCost,
                  )
                : downPreview.status === "PREVIEWING"
                  ? "Calculating..."
                  : downPreview.status === "ERROR"
                    ? "Odds unavailable"
                    : "--",
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
            payoutLabel: lastRedeem
                ? `${formatTokenAmount(lastRedeem.payout, PREDICT_BINARY_CONFIG.quoteDecimals)} DUSDC`
                : null,
            explorerUrl: lastDigest ? predictBinaryExplorerUrl(lastDigest) : null,
            placeBet,
        }),
        [
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
            txStatus,
            upPreview,
            downPreview,
        ],
    );
}
