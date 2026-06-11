"use client";

import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PredictRoundMarket } from "@/src/features/predict-round/use-predict-round";
import { formatTokenAmount } from "@/src/lib/plp-sandbox/amounts";
import {
    type MintedPositionEvent,
    type RangeMintEvent,
    type RedeemedPositionEvent,
    readDigest,
    readRedeemEvent,
} from "@/src/lib/predict-binary/client";
import { PREDICT_BINARY_CONFIG, predictBinaryExplorerUrl } from "@/src/lib/predict-binary/config";
import { formatBinaryOddsFromQuantity } from "@/src/lib/predict-binary/odds";
import {
    deserializeMintedEvent,
    deserializeRangeMintedEvent,
    deserializeRedeemedEvent,
} from "@/src/lib/predict-binary/portfolio";
import {
    createClaimBinaryPayoutTransaction,
    describeClaimBinaryPayoutMoveCalls,
} from "@/src/lib/predict-binary/transactions";
import {
    isWalletUserRejection,
    readWalletCancellationDebug,
    readWalletErrorMessage,
} from "@/src/lib/wallet-errors";

type PortfolioType = "Binary" | "Range" | "Break";
type PortfolioSide = "UP" | "DOWN" | "RANGE" | "BREAK";
type BinarySide = "UP" | "DOWN";
type BinaryPositionStatus = "Open" | "Claim" | "Claimed" | "Lose" | "Pending";

interface OracleSettlementState {
    lifecycle: string | null;
    settlementPrice: bigint | null;
}

interface PortfolioPosition {
    key: string;
    oracleId: string;
    expiryMs: number;
    strike: bigint;
    isUp: boolean;
    side: BinarySide;
    totalCost: bigint;
    totalQuantity: bigint;
    redeemedQuantity: bigint;
    managerIds: string[];
    status: BinaryPositionStatus;
    settlementPrice: bigint | null;
    canRedeem: boolean;
    redeemQuantity: bigint;
    redeemManagerId: string | null;
}

interface BinaryPortfolioState {
    minted: MintedPositionEvent[];
    rangeMinted: RangeMintEvent[];
    redeemed: RedeemedPositionEvent[];
    claimedKeys: string[];
    oracleSettlements: Record<string, OracleSettlementState>;
    mintedPagesRead: number;
    rangePagesRead: number;
    redeemedPagesRead: number;
    mintedReachedLimit: boolean;
    rangeReachedLimit: boolean;
    redeemedReachedLimit: boolean;
}

interface DisplayPosition {
    key: string;
    type: PortfolioType;
    side: PortfolioSide;
    totalCost: bigint;
    totalQuantity: bigint;
    strikeLabel: string;
    expiryMs: number;
    status: BinaryPositionStatus;
    canRedeem: boolean;
    binaryPosition: PortfolioPosition | null;
}

interface DisplayHistoryItem {
    key: string;
    positionGroupKey: string;
    dateMs: number | null;
    roundEndMs: number;
    type: PortfolioType;
    side: PortfolioSide;
    oddsQuantity: bigint;
    oddsCost: bigint;
    betCost: bigint;
    payoutLabel: string;
    status: BinaryPositionStatus | "Unknown";
    actionDigest: string | null;
    binaryPosition: PortfolioPosition | null;
    canShowRedeem: boolean;
}

const MINTED_EVENT_MAX_PAGES = 40;
const EVENT_PAGE_SIZE = 50;
const HISTORY_PAGE_SIZE = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positionKey({
    oracleId,
    expiryMs,
    strike,
    isUp,
}: {
    oracleId: string;
    expiryMs: number;
    strike: bigint;
    isUp: boolean;
}): string {
    return [oracleId, expiryMs.toString(), strike.toString(), isUp ? "UP" : "DOWN"].join(":");
}

function rangePositionKey(event: RangeMintEvent): string {
    return [
        "RANGE",
        event.oracleId,
        event.expiryMs.toString(),
        event.lowerStrike.toString(),
        event.higherStrike.toString(),
    ].join(":");
}

function eventKey(event: MintedPositionEvent): string {
    return [
        event.digest ?? "no-digest",
        event.oracleId,
        event.expiryMs.toString(),
        event.strike.toString(),
        event.isUp ? "UP" : "DOWN",
        event.quantity.toString(),
        event.cost.toString(),
        event.timestampMs?.toString() ?? "no-time",
    ].join(":");
}

function rangeEventKey(event: RangeMintEvent): string {
    return [
        event.digest ?? "no-digest",
        "RANGE",
        event.oracleId,
        event.expiryMs.toString(),
        event.lowerStrike.toString(),
        event.higherStrike.toString(),
        event.quantity.toString(),
        event.cost.toString(),
        event.timestampMs?.toString() ?? "no-time",
    ].join(":");
}

function shortDigest(value: string | null): string {
    if (!value) {
        return "--";
    }
    return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function formatDateTime(ms: number | null): string {
    if (ms === null) {
        return "--";
    }
    const parts = new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Tokyo",
        hour12: false,
    }).formatToParts(new Date(ms));
    const month = parts.find((part) => part.type === "month")?.value ?? "";
    const day = parts.find((part) => part.type === "day")?.value ?? "";
    const hour = parts.find((part) => part.type === "hour")?.value ?? "";
    const minute = parts.find((part) => part.type === "minute")?.value ?? "";
    return `${month} ${day} ${hour}:${minute}`;
}

function formatDUSDC(value: bigint): string {
    return `${formatTokenAmount(value, PREDICT_BINARY_CONFIG.quoteDecimals)} DUSDC`;
}

function formatStrike(value: bigint): string {
    const scale = PREDICT_BINARY_CONFIG.priceScale;
    const price = Number(value / scale) + Number(value % scale) / Number(scale);
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
    }).format(price);
}

function formatRangeLabel(lower: bigint, higher: bigint): string {
    return `${formatStrike(lower)} - ${formatStrike(higher)}`;
}

function settledPriceForPosition(
    position: Pick<PortfolioPosition, "oracleId" | "expiryMs">,
    roundMarket: PredictRoundMarket | null,
    oracleSettlements: Record<string, OracleSettlementState>,
): { price: bigint | null; lifecycle: string | null } {
    const fetched = oracleSettlements[position.oracleId];
    if (fetched) {
        return { price: fetched.settlementPrice, lifecycle: fetched.lifecycle };
    }
    const candidates = [
        roundMarket?.previousOracle ?? null,
        roundMarket?.currentOracle ?? null,
    ].filter((value) => value !== null);
    const oracle = candidates.find(
        (candidate) =>
            candidate.oracleId === position.oracleId && candidate.expiryMs === position.expiryMs,
    );
    if (!oracle || oracle.lifecycle !== "settled" || !("settlementPriceRaw" in oracle)) {
        return { price: null, lifecycle: oracle?.lifecycle ?? null };
    }
    return {
        price: oracle.settlementPriceRaw ? BigInt(oracle.settlementPriceRaw) : null,
        lifecycle: oracle.lifecycle,
    };
}

function buildPositions({
    minted,
    redeemed,
    claimedKeys,
    oracleSettlements,
    roundMarket,
}: {
    minted: MintedPositionEvent[];
    redeemed: RedeemedPositionEvent[];
    claimedKeys: string[];
    oracleSettlements: Record<string, OracleSettlementState>;
    roundMarket: PredictRoundMarket | null;
}): PortfolioPosition[] {
    const grouped = new Map<string, PortfolioPosition>();
    for (const event of minted) {
        const key = positionKey(event);
        const current = grouped.get(key);
        if (!current) {
            grouped.set(key, {
                key,
                oracleId: event.oracleId,
                expiryMs: event.expiryMs,
                strike: event.strike,
                isUp: event.isUp,
                side: event.isUp ? "UP" : "DOWN",
                totalCost: event.cost,
                totalQuantity: event.quantity,
                redeemedQuantity: 0n,
                managerIds: [event.managerId],
                status: "Pending",
                settlementPrice: null,
                canRedeem: false,
                redeemQuantity: 0n,
                redeemManagerId: event.managerId,
            });
            continue;
        }
        current.totalCost += event.cost;
        current.totalQuantity += event.quantity;
        if (!current.managerIds.includes(event.managerId)) {
            current.managerIds.push(event.managerId);
        }
    }

    for (const event of redeemed) {
        const key = positionKey(event);
        const current = grouped.get(key);
        if (!current) {
            continue;
        }
        current.redeemedQuantity += event.quantity;
    }

    const nowMs = Date.now();
    const claimed = new Set(claimedKeys);
    for (const position of grouped.values()) {
        const settlement = settledPriceForPosition(position, roundMarket, oracleSettlements);
        position.settlementPrice = settlement.price;
        position.redeemQuantity =
            position.totalQuantity > position.redeemedQuantity
                ? position.totalQuantity - position.redeemedQuantity
                : 0n;
        position.redeemManagerId =
            position.managerIds.length === 1 ? (position.managerIds[0] ?? null) : null;

        if (claimed.has(position.key)) {
            position.status = "Claimed";
            position.canRedeem = false;
            continue;
        }
        if (position.redeemedQuantity >= position.totalQuantity) {
            position.status = "Pending";
            position.canRedeem = false;
            continue;
        }
        if (nowMs < position.expiryMs) {
            position.status = "Open";
            position.canRedeem = false;
            continue;
        }
        if (position.settlementPrice === null) {
            position.status = "Pending";
            position.canRedeem = false;
            continue;
        }
        const won = position.isUp
            ? position.settlementPrice > position.strike
            : position.settlementPrice <= position.strike;
        if (!won) {
            position.status = "Lose";
            position.canRedeem = false;
            continue;
        }
        position.status = position.redeemManagerId ? "Claim" : "Pending";
        position.canRedeem = Boolean(position.redeemManagerId) && position.redeemQuantity > 0n;
    }

    return [...grouped.values()].sort((left, right) => right.expiryMs - left.expiryMs);
}

function buildBreakGroups(events: MintedPositionEvent[]): Map<
    string,
    {
        key: string;
        lower: MintedPositionEvent;
        upper: MintedPositionEvent;
        totalCost: bigint;
        effectivePayout: bigint;
    }
> {
    const byDigest = new Map<string, MintedPositionEvent[]>();
    for (const event of events) {
        if (!event.digest) {
            continue;
        }
        const current = byDigest.get(event.digest) ?? [];
        current.push(event);
        byDigest.set(event.digest, current);
    }

    const groups = new Map<
        string,
        {
            key: string;
            lower: MintedPositionEvent;
            upper: MintedPositionEvent;
            totalCost: bigint;
            effectivePayout: bigint;
        }
    >();
    for (const [digest, digestEvents] of byDigest) {
        const downLegs = digestEvents.filter((event) => !event.isUp);
        const upLegs = digestEvents.filter((event) => event.isUp);
        for (const lower of downLegs) {
            const upper = upLegs.find(
                (event) =>
                    event.trader === lower.trader &&
                    event.predictId === lower.predictId &&
                    event.managerId === lower.managerId &&
                    event.oracleId === lower.oracleId &&
                    event.expiryMs === lower.expiryMs &&
                    event.quoteAssetName === lower.quoteAssetName &&
                    event.strike > lower.strike &&
                    event.quantity > 0n &&
                    event.cost > 0n,
            );
            if (!upper || lower.quantity <= 0n || lower.cost <= 0n) {
                continue;
            }
            const key = [
                "BREAK",
                digest,
                lower.oracleId,
                lower.expiryMs.toString(),
                lower.strike.toString(),
                upper.strike.toString(),
            ].join(":");
            groups.set(key, {
                key,
                lower,
                upper,
                totalCost: lower.cost + upper.cost,
                effectivePayout: lower.quantity < upper.quantity ? lower.quantity : upper.quantity,
            });
        }
    }
    return groups;
}

function isCurrentPosition(position: PortfolioPosition): boolean {
    return position.expiryMs > Date.now() && position.status === "Open";
}

function statusClass(status: BinaryPositionStatus): string {
    if (status === "Lose" || status === "Claimed") {
        return "is-muted";
    }
    if (status === "Claim") {
        return "is-actionable";
    }
    return "";
}

function payoutLabel(position: PortfolioPosition | null): string {
    if (!position) {
        return "--";
    }
    if (position.status === "Lose") {
        return "0 DUSDC";
    }
    if (position.status === "Claim" || position.status === "Claimed") {
        return formatDUSDC(position.totalQuantity);
    }
    return "--";
}

function rangeStatus(
    event: RangeMintEvent,
    oracleSettlements: Record<string, OracleSettlementState>,
): BinaryPositionStatus {
    if (Date.now() < event.expiryMs) {
        return "Open";
    }
    const settlement = oracleSettlements[event.oracleId];
    if (!settlement?.settlementPrice) {
        return "Pending";
    }
    const won =
        settlement.settlementPrice > event.lowerStrike &&
        settlement.settlementPrice <= event.higherStrike;
    return won ? "Claim" : "Lose";
}

function breakStatus({
    group,
    oracleSettlements,
    positionByKey,
}: {
    group: {
        lower: MintedPositionEvent;
        upper: MintedPositionEvent;
    };
    oracleSettlements: Record<string, OracleSettlementState>;
    positionByKey: Map<string, PortfolioPosition>;
}): { status: BinaryPositionStatus; winningPosition: PortfolioPosition | null } {
    if (Date.now() < group.lower.expiryMs) {
        return { status: "Open", winningPosition: null };
    }
    const settlement = oracleSettlements[group.lower.oracleId];
    if (!settlement?.settlementPrice) {
        return { status: "Pending", winningPosition: null };
    }
    if (settlement.settlementPrice <= group.lower.strike) {
        const winningPosition = positionByKey.get(positionKey(group.lower)) ?? null;
        return { status: winningPosition?.status ?? "Claim", winningPosition };
    }
    if (settlement.settlementPrice > group.upper.strike) {
        const winningPosition = positionByKey.get(positionKey(group.upper)) ?? null;
        return { status: winningPosition?.status ?? "Claim", winningPosition };
    }
    return { status: "Lose", winningPosition: null };
}

function readOwnerAddress(value: unknown): string | null {
    if (typeof value === "string") {
        return value;
    }
    if (!isRecord(value)) {
        return null;
    }
    const addressOwner = value.AddressOwner;
    return typeof addressOwner === "string" ? addressOwner : null;
}

function hasPositiveWalletDusdcBalanceChange(
    balanceChanges: unknown,
    walletAddress: string,
): boolean {
    if (!Array.isArray(balanceChanges)) {
        return false;
    }
    return balanceChanges.some((change) => {
        if (!isRecord(change)) {
            return false;
        }
        const owner = readOwnerAddress(change.owner);
        const coinType = typeof change.coinType === "string" ? change.coinType : null;
        const amount = typeof change.amount === "string" ? change.amount : null;
        return (
            owner?.toLowerCase() === walletAddress.toLowerCase() &&
            coinType === PREDICT_BINARY_CONFIG.quoteCoinType &&
            amount !== null &&
            BigInt(amount) > 0n
        );
    });
}

async function fetchOracleSettlements(
    oracleIds: string[],
): Promise<Record<string, OracleSettlementState>> {
    const uniqueOracleIds = [...new Set(oracleIds)].filter((oracleId) => oracleId.length > 0);
    if (uniqueOracleIds.length === 0) {
        return {};
    }
    const response = await fetch("/api/predict/oracle-states", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oracleIds: uniqueOracleIds }),
    });
    if (!response.ok) {
        throw new Error(`Oracle settlement query failed: ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    if (!isRecord(payload) || !Array.isArray(payload.states)) {
        throw new Error("Invalid oracle settlement query response");
    }
    const settlements: Record<string, OracleSettlementState> = {};
    for (const state of payload.states) {
        if (!isRecord(state) || typeof state.oracleId !== "string") {
            continue;
        }
        const settlementPriceRaw =
            typeof state.settlementPriceRaw === "string" &&
            /^(0|[1-9]\d*)$/.test(state.settlementPriceRaw)
                ? state.settlementPriceRaw
                : null;
        settlements[state.oracleId] = {
            lifecycle: typeof state.lifecycle === "string" ? state.lifecycle : null,
            settlementPrice: settlementPriceRaw === null ? null : BigInt(settlementPriceRaw),
        };
    }
    return settlements;
}

function isSuccessfulTransactionResult(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    const directEffects = isRecord(value.effects) ? value.effects : null;
    const transaction = isRecord(value.Transaction) ? value.Transaction : null;
    const transactionEffects =
        transaction && isRecord(transaction.effects) ? transaction.effects : null;
    const status =
        (isRecord(transactionEffects?.status) ? transactionEffects.status.status : null) ??
        (isRecord(directEffects?.status) ? directEffects.status.status : null);
    return status === "success";
}

export function BinaryPortfolioSection({
    roundMarket,
}: {
    roundMarket: PredictRoundMarket | null;
}) {
    const account = useCurrentAccount();
    const client = useCurrentClient();
    const dAppKit = useDAppKit();
    const address = account?.address ?? null;
    const [state, setState] = useState<BinaryPortfolioState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [redeemingKey, setRedeemingKey] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [historyPage, setHistoryPage] = useState(1);

    const refresh = useCallback(async () => {
        if (!address) {
            setState(null);
            setError(null);
            setMessage(null);
            setHistoryPage(1);
            return;
        }
        setIsLoading(true);
        setError(null);
        try {
            // Stage 1: 新 API を呼ぶ
            const response = await fetch("/api/predict/portfolio", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ walletAddress: address }),
            });
            const payload = await response.json();
            if (!payload.ok) throw new Error(payload.error ?? "Portfolio fetch failed");

            const minted = payload.minted.map(deserializeMintedEvent);
            const rangeMinted = payload.rangeMinted.map(deserializeRangeMintedEvent);
            const redeemed = payload.redeemed.map(deserializeRedeemedEvent);
            const claimedKeys: string[] = payload.claimedKeys;

            // 即描画（settlements はまだ空）
            setState({
                minted,
                rangeMinted,
                redeemed,
                claimedKeys,
                oracleSettlements: {},
                mintedPagesRead: 0,
                rangePagesRead: 0,
                redeemedPagesRead: 0,
                mintedReachedLimit: payload.reachedPageLimit ?? false,
                rangeReachedLimit: payload.reachedPageLimit ?? false,
                redeemedReachedLimit: false,
            });
            setHistoryPage(1);

            // Stage 2: oracle settlements を後追い取得
            const oracleIds = [
                ...new Set([
                    ...minted.map((e: MintedPositionEvent) => e.oracleId),
                    ...rangeMinted.map((e: RangeMintEvent) => e.oracleId),
                ]),
            ];
            if (oracleIds.length > 0) {
                const oracleSettlements = await fetchOracleSettlements(oracleIds);
                setState((prev) => (prev ? { ...prev, oracleSettlements } : prev));
            }
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setIsLoading(false);
        }
    }, [address]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const positions = useMemo(
        () =>
            buildPositions({
                minted: state?.minted ?? [],
                redeemed: state?.redeemed ?? [],
                claimedKeys: state?.claimedKeys ?? [],
                oracleSettlements: state?.oracleSettlements ?? {},
                roundMarket,
            }),
        [roundMarket, state],
    );
    const currentPositions = useMemo(() => positions.filter(isCurrentPosition), [positions]);
    const positionByKey = useMemo(
        () => new Map(positions.map((position) => [position.key, position])),
        [positions],
    );
    const breakGroups = useMemo(() => buildBreakGroups(state?.minted ?? []), [state]);
    const breakLegEventKeys = useMemo(() => {
        const keys = new Set<string>();
        for (const group of breakGroups.values()) {
            keys.add(eventKey(group.lower));
            keys.add(eventKey(group.upper));
        }
        return keys;
    }, [breakGroups]);
    const currentDisplayPositions = useMemo<DisplayPosition[]>(() => {
        const binaryItems = currentPositions
            .filter((position) => {
                const matchingEvents =
                    state?.minted.filter((event) => positionKey(event) === position.key) ?? [];
                return !matchingEvents.some((event) => breakLegEventKeys.has(eventKey(event)));
            })
            .map(
                (position): DisplayPosition => ({
                    key: position.key,
                    type: "Binary",
                    side: position.side,
                    totalCost: position.totalCost,
                    totalQuantity: position.totalQuantity,
                    strikeLabel: formatStrike(position.strike),
                    expiryMs: position.expiryMs,
                    status: position.status,
                    canRedeem: position.canRedeem,
                    binaryPosition: position,
                }),
            );
        const nowMs = Date.now();
        const rangeItems = (state?.rangeMinted ?? [])
            .filter((event) => nowMs < event.expiryMs)
            .map(
                (event): DisplayPosition => ({
                    key: rangePositionKey(event),
                    type: "Range",
                    side: "RANGE",
                    totalCost: event.cost,
                    totalQuantity: event.quantity,
                    strikeLabel: formatRangeLabel(event.lowerStrike, event.higherStrike),
                    expiryMs: event.expiryMs,
                    status: "Open",
                    canRedeem: false,
                    binaryPosition: null,
                }),
            );
        const breakItems = [...breakGroups.values()]
            .filter((group) => nowMs < group.lower.expiryMs)
            .map(
                (group): DisplayPosition => ({
                    key: group.key,
                    type: "Break",
                    side: "BREAK",
                    totalCost: group.totalCost,
                    totalQuantity: group.effectivePayout,
                    strikeLabel: formatRangeLabel(group.lower.strike, group.upper.strike),
                    expiryMs: group.lower.expiryMs,
                    status: "Open",
                    canRedeem: false,
                    binaryPosition: null,
                }),
            );
        return [...binaryItems, ...rangeItems, ...breakItems].sort(
            (left, right) => right.expiryMs - left.expiryMs,
        );
    }, [breakGroups, breakLegEventKeys, currentPositions, state]);
    const currentDisplayPositionKeys = useMemo(
        () => new Set(currentDisplayPositions.map((position) => position.key)),
        [currentDisplayPositions],
    );
    const history = useMemo<DisplayHistoryItem[]>(() => {
        const binaryItems = (state?.minted ?? [])
            .filter((event) => !breakLegEventKeys.has(eventKey(event)))
            .map((event): DisplayHistoryItem => {
                const groupKey = positionKey(event);
                const position = positionByKey.get(groupKey) ?? null;
                return {
                    key: `BINARY:${eventKey(event)}`,
                    positionGroupKey: groupKey,
                    dateMs: event.timestampMs,
                    roundEndMs: event.expiryMs,
                    type: "Binary",
                    side: event.isUp ? "UP" : "DOWN",
                    oddsQuantity: event.quantity,
                    oddsCost: event.cost,
                    betCost: event.cost,
                    payoutLabel: payoutLabel(position),
                    status: position?.status ?? "Unknown",
                    actionDigest: event.digest,
                    binaryPosition: position,
                    canShowRedeem: false,
                };
            });
        const rangeItems = (state?.rangeMinted ?? []).map((event): DisplayHistoryItem => {
            const status = rangeStatus(event, state?.oracleSettlements ?? {});
            return {
                key: `RANGE:${rangeEventKey(event)}`,
                positionGroupKey: rangePositionKey(event),
                dateMs: event.timestampMs,
                roundEndMs: event.expiryMs,
                type: "Range",
                side: "RANGE",
                oddsQuantity: event.quantity,
                oddsCost: event.cost,
                betCost: event.cost,
                payoutLabel: status === "Lose" ? "0 DUSDC" : formatDUSDC(event.quantity),
                status,
                actionDigest: event.digest,
                binaryPosition: null,
                canShowRedeem: false,
            };
        });
        const breakItems = [...breakGroups.values()].map((group): DisplayHistoryItem => {
            const status = breakStatus({
                group,
                oracleSettlements: state?.oracleSettlements ?? {},
                positionByKey,
            });
            return {
                key: group.key,
                positionGroupKey: group.key,
                dateMs: group.lower.timestampMs ?? group.upper.timestampMs,
                roundEndMs: group.lower.expiryMs,
                type: "Break",
                side: "BREAK",
                oddsQuantity: group.effectivePayout,
                oddsCost: group.totalCost,
                betCost: group.totalCost,
                payoutLabel:
                    status.status === "Lose" ? "0 DUSDC" : formatDUSDC(group.effectivePayout),
                status: status.status,
                actionDigest: group.lower.digest,
                binaryPosition: status.winningPosition,
                canShowRedeem: false,
            };
        });
        return [...binaryItems, ...rangeItems, ...breakItems]
            .filter((item) => !currentDisplayPositionKeys.has(item.positionGroupKey))
            .sort((left, right) => (right.dateMs ?? 0) - (left.dateMs ?? 0));
    }, [breakGroups, breakLegEventKeys, currentDisplayPositionKeys, positionByKey, state]);
    const historyPageCount = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE));
    const safeHistoryPage = Math.min(historyPage, historyPageCount);
    const pagedHistory = history.slice(
        (safeHistoryPage - 1) * HISTORY_PAGE_SIZE,
        safeHistoryPage * HISTORY_PAGE_SIZE,
    );
    const historyActionKeys = useMemo(() => {
        const keys = new Set<string>();
        for (const item of history) {
            const position = item.binaryPosition;
            if (position?.canRedeem) {
                keys.add(position.key);
            }
        }
        return keys;
    }, [history]);

    const redeem = async (position: PortfolioPosition) => {
        if (!address || !position.canRedeem || !position.redeemManagerId) {
            return;
        }
        setRedeemingKey(position.key);
        setMessage("Confirm in wallet");
        try {
            const tx = createClaimBinaryPayoutTransaction({
                sender: address,
                managerId: position.redeemManagerId,
                oracleId: position.oracleId,
                expiryMs: position.expiryMs,
                strike: position.strike,
                isUp: position.isUp,
                quantity: position.redeemQuantity,
            });
            console.info("Binary portfolio Claim Payout transaction", {
                moveCalls: describeClaimBinaryPayoutMoveCalls(),
                managerId: position.redeemManagerId,
                oracleId: position.oracleId,
                expiryMs: position.expiryMs,
                referenceStrikeRaw: position.strike.toString(),
                isUp: position.isUp,
                quantity: position.redeemQuantity.toString(),
            });
            const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
            const digest = readDigest(result);
            const executed = await client.core.waitForTransaction({
                digest,
                timeout: 60_000,
                include: { events: true, balanceChanges: true, effects: true },
            });
            const redeemed = readRedeemEvent(executed.Transaction?.events);
            const walletReceivedDusdc =
                isSuccessfulTransactionResult(executed) &&
                hasPositiveWalletDusdcBalanceChange(executed.Transaction?.balanceChanges, address);
            setMessage(
                walletReceivedDusdc
                    ? `Claimed ${formatDUSDC(redeemed.payout)}`
                    : "Redeemed to manager. Withdraw DUSDC may be needed.",
            );
            await refresh();
        } catch (caught) {
            if (isWalletUserRejection(caught)) {
                console.info(
                    "Binary portfolio Claim Payout transaction cancelled",
                    readWalletCancellationDebug(caught),
                );
                setMessage("Transaction cancelled");
                return;
            }
            setMessage(readWalletErrorMessage(caught));
        } finally {
            setRedeemingKey(null);
        }
    };

    const renderedActionKeys = new Set<string>();

    return (
        <section className="binary-portfolio">
            <section className="surface binary-portfolio-panel">
                <div className="section-title">
                    <div>
                        <span>BTC Binary</span>
                        <h2>Current Positions</h2>
                    </div>
                    <button type="button" className="text-action" onClick={() => void refresh()}>
                        Refresh
                    </button>
                </div>
                {!address ? (
                    <div className="empty-state">Connect wallet to load BTC Binary positions.</div>
                ) : error ? (
                    <div className="empty-state">Binary history fetch failed: {error}</div>
                ) : isLoading && !state ? (
                    <div className="empty-state">Loading BTC Binary positions...</div>
                ) : currentDisplayPositions.length === 0 ? (
                    <div className="empty-state">
                        No current BTC Binary positions found in fetched events.
                    </div>
                ) : (
                    <div className="binary-position-table">
                        {currentDisplayPositions.map((position) => (
                            <article key={position.key}>
                                <div>
                                    <span>Market</span>
                                    <strong>BTC</strong>
                                </div>
                                <div>
                                    <span>Type</span>
                                    <strong>{position.type}</strong>
                                </div>
                                <div>
                                    <span>Side</span>
                                    <strong
                                        className={`binary-side ${position.side.toLowerCase()}`}
                                    >
                                        {position.side}
                                    </strong>
                                </div>
                                <div>
                                    <span>Bet</span>
                                    <strong>{formatDUSDC(position.totalCost)}</strong>
                                </div>
                                <div>
                                    <span>Max Payout</span>
                                    <strong>{formatDUSDC(position.totalQuantity)}</strong>
                                </div>
                                <div>
                                    <span>Entry Odds</span>
                                    <strong>
                                        {formatBinaryOddsFromQuantity(
                                            position.totalQuantity,
                                            position.totalCost,
                                        )}
                                    </strong>
                                </div>
                                <div>
                                    <span>Strike</span>
                                    <strong>{position.strikeLabel}</strong>
                                </div>
                                <div>
                                    <span>Round ends</span>
                                    <strong>{formatDateTime(position.expiryMs)}</strong>
                                </div>
                                <div>
                                    <span>Status</span>
                                    <strong>{position.status}</strong>
                                </div>
                            </article>
                        ))}
                    </div>
                )}
                <p className="binary-portfolio-note">
                    Current Positions are restored from fetched PositionMinted events. Query cap:{" "}
                    {MINTED_EVENT_MAX_PAGES * EVENT_PAGE_SIZE} mint events
                    {state
                        ? `, ${state.mintedPagesRead} binary mint pages and ${state.rangePagesRead} range mint pages read`
                        : ""}
                    .
                    {state?.mintedReachedLimit
                        ? " Binary mint fetch limit reached; more binary history may exist."
                        : ""}
                    {state?.rangeReachedLimit
                        ? " Range mint fetch limit reached; more range history may exist."
                        : ""}
                    {state?.redeemedReachedLimit
                        ? " Redeem fetch limit reached; claim status may be incomplete."
                        : ""}
                </p>
                {message ? <p className="binary-portfolio-note">{message}</p> : null}
            </section>

            <section className="surface binary-portfolio-panel">
                <div className="section-title">
                    <div>
                        <span>BTC Binary</span>
                        <h2>Your history</h2>
                    </div>
                    <strong>
                        {history.length} records · Page {safeHistoryPage} / {historyPageCount}
                    </strong>
                </div>
                {history.length === 0 ? (
                    <div className="empty-state">No PositionMinted history in fetched events.</div>
                ) : (
                    <>
                        <div className="binary-history-list">
                            {pagedHistory.map((item) => {
                                const digest = item.actionDigest;
                                const position = item.binaryPosition;
                                const redeemablePosition = position?.canRedeem ? position : null;
                                const canShowRedeem =
                                    redeemablePosition !== null &&
                                    historyActionKeys.has(redeemablePosition.key) &&
                                    !renderedActionKeys.has(redeemablePosition.key);
                                if (canShowRedeem) {
                                    renderedActionKeys.add(redeemablePosition.key);
                                }
                                return (
                                    <article
                                        key={item.key}
                                        className={position ? statusClass(position.status) : ""}
                                    >
                                        <div>
                                            <span>Date</span>
                                            <strong>{formatDateTime(item.dateMs)}</strong>
                                        </div>
                                        <div>
                                            <span>Ended</span>
                                            <strong>{formatDateTime(item.roundEndMs)}</strong>
                                        </div>
                                        <div>
                                            <span>Type</span>
                                            <strong>{item.type}</strong>
                                        </div>
                                        <div>
                                            <span>Side</span>
                                            <strong
                                                className={`binary-side ${item.side.toLowerCase()}`}
                                            >
                                                {item.side}
                                            </strong>
                                        </div>
                                        <div>
                                            <span>Odds</span>
                                            <strong>
                                                {formatBinaryOddsFromQuantity(
                                                    item.oddsQuantity,
                                                    item.oddsCost,
                                                )}
                                            </strong>
                                        </div>
                                        <div>
                                            <span>Bet</span>
                                            <strong>{formatDUSDC(item.betCost)}</strong>
                                        </div>
                                        <div>
                                            <span>Payout</span>
                                            <strong>{item.payoutLabel}</strong>
                                        </div>
                                        <div>
                                            <span>Status</span>
                                            <strong>{item.status}</strong>
                                        </div>
                                        <div className="binary-history-action">
                                            {canShowRedeem && position ? (
                                                <button
                                                    type="button"
                                                    className="text-action"
                                                    disabled={redeemingKey === position.key}
                                                    onClick={() => void redeem(position)}
                                                >
                                                    {redeemingKey === position.key
                                                        ? "Redeeming..."
                                                        : "Claim Payout"}
                                                </button>
                                            ) : position?.status === "Claimed" ? (
                                                <span>Claimed</span>
                                            ) : digest ? (
                                                <a
                                                    href={predictBinaryExplorerUrl(digest)}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                >
                                                    {shortDigest(digest)}
                                                </a>
                                            ) : (
                                                <span>--</span>
                                            )}
                                        </div>
                                    </article>
                                );
                            })}
                        </div>
                        {historyPageCount > 1 ? (
                            <div className="binary-history-pagination">
                                <button
                                    type="button"
                                    className="text-action"
                                    disabled={safeHistoryPage <= 1}
                                    onClick={() =>
                                        setHistoryPage((current) => Math.max(1, current - 1))
                                    }
                                >
                                    Previous
                                </button>
                                <span>
                                    {Math.min(
                                        (safeHistoryPage - 1) * HISTORY_PAGE_SIZE + 1,
                                        history.length,
                                    )}
                                    -{Math.min(safeHistoryPage * HISTORY_PAGE_SIZE, history.length)}
                                </span>
                                <button
                                    type="button"
                                    className="text-action"
                                    disabled={safeHistoryPage >= historyPageCount}
                                    onClick={() =>
                                        setHistoryPage((current) =>
                                            Math.min(historyPageCount, current + 1),
                                        )
                                    }
                                >
                                    Next
                                </button>
                            </div>
                        ) : null}
                    </>
                )}
            </section>
        </section>
    );
}
