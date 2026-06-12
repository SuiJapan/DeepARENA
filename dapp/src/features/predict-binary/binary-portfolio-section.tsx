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
    createClaimBinaryPayoutTransaction,
    createWithdrawManagerQuoteTransaction,
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
// Pending/Claim を廃止: 満期後 settlement 待ちは Settling、勝ち未 claim は Win
type BinaryPositionStatus = "Open" | "Settling" | "Win" | "Claimed" | "Lose";

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
    redeemedPayout: bigint;
    managerIds: string[];
    status: BinaryPositionStatus;
    settlementPrice: bigint | null;
    canRedeem: boolean;
    // "redeem": 未 redeem 分を redeem + withdraw で wallet へ（Case A）
    claimKind: "redeem" | null;
    redeemQuantity: bigint;
    redeemManagerId: string | null;
}

interface BinaryPortfolioState {
    minted: MintedPositionEvent[];
    rangeMinted: RangeMintEvent[];
    redeemed: RedeemedPositionEvent[];
    claimedKeys: string[];
    oracleSettlements: Record<string, OracleSettlementState>;
    managerBalances: Record<string, bigint>;
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
    // アコーディオン詳細用
    oracleId: string;
    isUp: boolean | null;
    settlementLifecycle: string | null;
    settlementPriceLabel: string | null;
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
    managerBalances,
    roundMarket,
}: {
    minted: MintedPositionEvent[];
    redeemed: RedeemedPositionEvent[];
    claimedKeys: string[];
    oracleSettlements: Record<string, OracleSettlementState>;
    managerBalances: Record<string, bigint>;
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
                redeemedPayout: 0n,
                managerIds: [event.managerId],
                status: "Settling",
                settlementPrice: null,
                canRedeem: false,
                claimKind: null,
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
        current.redeemedPayout += event.payout;
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

        // CLAIMED は「wallet が実際に DUSDC を受領した TX が確認できた」場合のみ。
        // 自動 redeem（payout は manager に入るだけ）は CLAIMED にしない。
        if (claimed.has(position.key)) {
            position.status = "Claimed";
            position.canRedeem = false;
            continue;
        }
        if (nowMs < position.expiryMs) {
            position.status = "Open";
            position.canRedeem = false;
            continue;
        }
        // 勝敗判定: settlement price を優先。取得できない場合でも、
        // 全量 redeem 済みなら oracle は settled なので redeem payout で代替判定する
        // （満期後の自動 redeem は負けでも payout=0 で実行されるため、
        //  redeem 済みであること自体は勝敗の根拠にならない）。
        let won: boolean | null = null;
        if (position.settlementPrice !== null) {
            won = position.isUp
                ? position.settlementPrice > position.strike
                : position.settlementPrice <= position.strike;
        } else if (position.redeemedQuantity >= position.totalQuantity) {
            won = position.redeemedPayout > 0n;
        }
        if (won === null) {
            // 満期後、settlement price も redeem 実績もまだ無い
            position.status = "Settling";
            position.canRedeem = false;
            continue;
        }
        if (!won) {
            position.status = "Lose";
            position.canRedeem = false;
            continue;
        }
        position.status = "Win";
        if (position.redeemManagerId && position.redeemQuantity > 0n) {
            // Case A: 未 redeem 分が残っている → redeem + withdraw で wallet へ
            position.claimKind = "redeem";
            position.canRedeem = true;
        } else if (position.redeemManagerId && position.redeemedPayout > 0n) {
            // Case B: 自動 redeem 済み（payout は manager 内）。
            // 同一 manager に複数の自動 redeem 済みポジションがある場合、
            // per-position の Claim ボタンは manager 残高の二重引き出しリスクがある。
            // そのため per-position Claim は提示せず、Collect ボタンで一括回収する。
            // Collect 後に残高が 0 になると balance < redeemedPayout → CLAIMED に変わる。
            const balance = managerBalances[position.redeemManagerId];
            if (balance !== undefined && balance < position.redeemedPayout) {
                position.status = "Claimed";
                position.canRedeem = false;
            }
            // else: Win のまま・canRedeem = false。Collect ボタンで回収する。
        }
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

function displayStatus(status: BinaryPositionStatus | "Unknown"): string {
    switch (status) {
        case "Open":
            return "OPEN";
        case "Settling":
            return "SETTLING";
        case "Win":
            return "WIN";
        case "Claimed":
            return "CLAIMED";
        case "Lose":
            return "LOSE";
        default:
            return "UNKNOWN";
    }
}

function statusClass(status: BinaryPositionStatus): string {
    if (status === "Lose" || status === "Claimed") {
        return "is-muted";
    }
    if (status === "Win") {
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
    if (position.status === "Win" || position.status === "Claimed") {
        // redeem 実績があれば実際の払戻額、無ければ最大払戻（quantity）を表示
        return formatDUSDC(
            position.redeemedPayout > 0n ? position.redeemedPayout : position.totalQuantity,
        );
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
        return "Settling";
    }
    const won =
        settlement.settlementPrice > event.lowerStrike &&
        settlement.settlementPrice <= event.higherStrike;
    return won ? "Win" : "Lose";
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
        return { status: "Settling", winningPosition: null };
    }
    if (settlement.settlementPrice <= group.lower.strike) {
        const winningPosition = positionByKey.get(positionKey(group.lower)) ?? null;
        return { status: winningPosition?.status ?? "Win", winningPosition };
    }
    if (settlement.settlementPrice > group.upper.strike) {
        const winningPosition = positionByKey.get(positionKey(group.upper)) ?? null;
        return { status: winningPosition?.status ?? "Win", winningPosition };
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

// --- Portfolio API response types & deserializers ---

interface SerializedMintedPositionEvent {
    predictId: string;
    managerId: string;
    oracleId: string;
    expiryMs: number;
    strike: string;
    isUp: boolean;
    quantity: string;
    cost: string;
    askPrice: string;
    trader: string;
    quoteAssetName: string;
    digest: string | null;
    timestampMs: number | null;
}

interface SerializedRangeMintEvent {
    predictId: string;
    managerId: string;
    trader: string;
    quoteAssetName: string;
    oracleId: string;
    expiryMs: number;
    lowerStrike: string;
    higherStrike: string;
    quantity: string;
    cost: string;
    askPrice: string;
    digest: string | null;
    timestampMs: number | null;
}

interface SerializedRedeemedPositionEvent {
    managerId: string;
    oracleId: string;
    expiryMs: number;
    strike: string;
    isUp: boolean;
    quantity: string;
    payout: string;
    bidPrice: string;
    isSettled: boolean;
    digest: string | null;
    timestampMs: number | null;
}

interface PortfolioApiResponse {
    minted: SerializedMintedPositionEvent[];
    rangeMinted: SerializedRangeMintEvent[];
    redeemed: SerializedRedeemedPositionEvent[];
    claimedKeys: string[];
    managerBalances: Record<string, string>;
    pagesInfo: {
        mintedPagesRead: number;
        mintedReachedLimit: boolean;
        rangePagesRead: number;
        rangeReachedLimit: boolean;
        redeemedPagesRead: number;
        redeemedReachedLimit: boolean;
    };
}

function deserializeMintedEvent(s: SerializedMintedPositionEvent): MintedPositionEvent {
    return {
        ...s,
        strike: BigInt(s.strike),
        quantity: BigInt(s.quantity),
        cost: BigInt(s.cost),
        askPrice: BigInt(s.askPrice),
    };
}

function deserializeRangeMintEvent(s: SerializedRangeMintEvent): RangeMintEvent {
    return {
        ...s,
        lowerStrike: BigInt(s.lowerStrike),
        higherStrike: BigInt(s.higherStrike),
        quantity: BigInt(s.quantity),
        cost: BigInt(s.cost),
        askPrice: BigInt(s.askPrice),
    };
}

function deserializeRedeemedEvent(s: SerializedRedeemedPositionEvent): RedeemedPositionEvent {
    return {
        ...s,
        strike: BigInt(s.strike),
        quantity: BigInt(s.quantity),
        payout: BigInt(s.payout),
        bidPrice: BigInt(s.bidPrice),
    };
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
    const [isCollecting, setIsCollecting] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [historyPage, setHistoryPage] = useState(1);
    const [expandedHistoryKeys, setExpandedHistoryKeys] = useState<Set<string>>(new Set());

    const toggleHistoryExpand = useCallback((key: string) => {
        setExpandedHistoryKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    }, []);

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
            const response = await fetch(
                `/api/predict/portfolio?wallet=${encodeURIComponent(address)}`,
            );
            if (!response.ok) {
                const errorBody = await response.json().catch(() => ({}));
                throw new Error(
                    `Portfolio fetch failed: ${(isRecord(errorBody) && typeof errorBody.error === "string" ? errorBody.error : null) ?? response.status}`,
                );
            }
            const data = (await response.json()) as PortfolioApiResponse;

            const mintedEvents = data.minted.map(deserializeMintedEvent);
            const rangeMintedEvents = data.rangeMinted.map(deserializeRangeMintEvent);
            const redeemedEvents = data.redeemed.map(deserializeRedeemedEvent);

            const oracleSettlements = await fetchOracleSettlements([
                ...mintedEvents.map((e) => e.oracleId),
                ...rangeMintedEvents.map((e) => e.oracleId),
            ]);

            const managerBalances: Record<string, bigint> = Object.fromEntries(
                Object.entries(data.managerBalances).map(([k, v]) => [k, BigInt(v)]),
            );

            setState({
                minted: mintedEvents,
                rangeMinted: rangeMintedEvents,
                redeemed: redeemedEvents,
                claimedKeys: data.claimedKeys,
                oracleSettlements,
                managerBalances,
                mintedPagesRead: data.pagesInfo.mintedPagesRead,
                rangePagesRead: data.pagesInfo.rangePagesRead,
                redeemedPagesRead: data.pagesInfo.redeemedPagesRead,
                mintedReachedLimit: data.pagesInfo.mintedReachedLimit,
                rangeReachedLimit: data.pagesInfo.rangeReachedLimit,
                redeemedReachedLimit: data.pagesInfo.redeemedReachedLimit,
            });
            setHistoryPage(1);
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
                managerBalances: state?.managerBalances ?? {},
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
        const oracleSettlements = state?.oracleSettlements ?? {};
        const binaryItems = (state?.minted ?? [])
            .filter((event) => !breakLegEventKeys.has(eventKey(event)))
            .map((event): DisplayHistoryItem => {
                const groupKey = positionKey(event);
                const position = positionByKey.get(groupKey) ?? null;
                const settlementState = oracleSettlements[event.oracleId];
                const settlementPrice = settlementState?.settlementPrice ?? null;
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
                    oracleId: event.oracleId,
                    isUp: event.isUp,
                    settlementLifecycle: settlementState?.lifecycle ?? null,
                    settlementPriceLabel:
                        settlementPrice !== null ? formatStrike(settlementPrice) : null,
                };
            });
        const rangeItems = (state?.rangeMinted ?? []).map((event): DisplayHistoryItem => {
            const status = rangeStatus(event, oracleSettlements);
            const settlementState = oracleSettlements[event.oracleId];
            const settlementPrice = settlementState?.settlementPrice ?? null;
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
                oracleId: event.oracleId,
                isUp: null,
                settlementLifecycle: settlementState?.lifecycle ?? null,
                settlementPriceLabel:
                    settlementPrice !== null ? formatStrike(settlementPrice) : null,
            };
        });
        const breakItems = [...breakGroups.values()].map((group): DisplayHistoryItem => {
            const status = breakStatus({
                group,
                oracleSettlements,
                positionByKey,
            });
            const settlementState = oracleSettlements[group.lower.oracleId];
            const settlementPrice = settlementState?.settlementPrice ?? null;
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
                oracleId: group.lower.oracleId,
                isUp: null,
                settlementLifecycle: settlementState?.lifecycle ?? null,
                settlementPriceLabel:
                    settlementPrice !== null ? formatStrike(settlementPrice) : null,
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

    // manager に残っている DUSDC の合計（BET 時の超過入金や未引き出し payout の残滓）
    const totalManagerBalance = useMemo(() => {
        const balances = state?.managerBalances ?? {};
        return Object.values(balances).reduce((total, balance) => total + balance, 0n);
    }, [state]);

    // 全 manager の残高をまとめて wallet へ引き出す（manager ごとに 1 TX）
    const collectManagerBalances = async () => {
        if (!address || !state) {
            return;
        }
        const entries = Object.entries(state.managerBalances).filter(([, balance]) => balance > 0n);
        if (entries.length === 0) {
            return;
        }
        setIsCollecting(true);
        setMessage("Confirm in wallet");
        try {
            let collected = 0n;
            for (const [managerId, balance] of entries) {
                const tx = createWithdrawManagerQuoteTransaction({
                    sender: address,
                    managerId,
                    amount: balance,
                });
                console.info("Binary portfolio Collect transaction", {
                    managerId,
                    amount: balance.toString(),
                });
                const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
                const digest = readDigest(result);
                await client.core.waitForTransaction({ digest, timeout: 60_000 });
                collected += balance;
            }
            setMessage(`Collected ${formatDUSDC(collected)} to wallet`);
            await refresh();
        } catch (caught) {
            if (isWalletUserRejection(caught)) {
                setMessage("Transaction cancelled");
                return;
            }
            setMessage(readWalletErrorMessage(caught));
        } finally {
            setIsCollecting(false);
        }
    };

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
                claimKind: position.claimKind,
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
            const claimedPayout = readRedeemEvent(executed.Transaction?.events).payout;
            const walletReceivedDusdc =
                isSuccessfulTransactionResult(executed) &&
                hasPositiveWalletDusdcBalanceChange(executed.Transaction?.balanceChanges, address);
            setMessage(
                walletReceivedDusdc
                    ? `Claimed ${formatDUSDC(claimedPayout)}`
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
                ) : error && !state ? (
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
                                    <strong>{displayStatus(position.status)}</strong>
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
                    {error && state
                        ? ` Last refresh failed (${error}); showing previously loaded data.`
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
                    <div className="history-title-side">
                        <strong>
                            {history.length} records · Page {safeHistoryPage} / {historyPageCount}
                        </strong>
                        {totalManagerBalance > 0n ? (
                            <button
                                type="button"
                                className="text-action"
                                disabled={isCollecting}
                                title="Withdraw all DUSDC remaining in your PredictManager (slippage deposits and unclaimed payouts) to your wallet"
                                onClick={() => void collectManagerBalances()}
                            >
                                {isCollecting
                                    ? "Collecting..."
                                    : `Collect ${formatDUSDC(totalManagerBalance)}`}
                            </button>
                        ) : null}
                    </div>
                </div>
                {history.length === 0 ? (
                    <div className="empty-state">No PositionMinted history in fetched events.</div>
                ) : (
                    <>
                        <div className="binary-history-list">
                            {pagedHistory.map((item) => {
                                const position = item.binaryPosition;
                                const isExpanded = expandedHistoryKeys.has(item.key);
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
                                            <strong
                                                className={`status-label status-${item.status.toLowerCase()}`}
                                            >
                                                {displayStatus(item.status)}
                                            </strong>
                                        </div>
                                        <div className="binary-history-action">
                                            <button
                                                type="button"
                                                className="accordion-chevron"
                                                onClick={() => toggleHistoryExpand(item.key)}
                                            >
                                                {isExpanded ? "▲" : "▼"}
                                            </button>
                                        </div>
                                        {isExpanded && (
                                            <div className="history-accordion">
                                                <div className="history-accordion-field">
                                                    <span>Oracle ID</span>
                                                    <small>{item.oracleId}</small>
                                                </div>
                                                <div className="history-accordion-field">
                                                    <span>Expiry</span>
                                                    <small>{formatDateTime(item.roundEndMs)}</small>
                                                </div>
                                                {item.binaryPosition && (
                                                    <div className="history-accordion-field">
                                                        <span>Strike</span>
                                                        <small>
                                                            {formatStrike(
                                                                item.binaryPosition.strike,
                                                            )}
                                                        </small>
                                                    </div>
                                                )}
                                                <div className="history-accordion-field">
                                                    <span>Side / is_up</span>
                                                    <small>
                                                        {item.side}
                                                        {item.isUp !== null
                                                            ? ` (is_up: ${String(item.isUp)})`
                                                            : ""}
                                                    </small>
                                                </div>
                                                <div className="history-accordion-field">
                                                    <span>Settlement Status</span>
                                                    <small>
                                                        {item.settlementLifecycle ?? "--"}
                                                    </small>
                                                </div>
                                                <div className="history-accordion-field">
                                                    <span>Settlement Price</span>
                                                    <small>
                                                        {item.settlementPriceLabel ?? "--"}
                                                    </small>
                                                </div>
                                                <div className="history-accordion-field">
                                                    <span>Redeemable Payout</span>
                                                    <small>
                                                        {item.binaryPosition
                                                            ? formatDUSDC(
                                                                  item.binaryPosition
                                                                      .redeemQuantity > 0n
                                                                      ? item.binaryPosition
                                                                            .redeemQuantity
                                                                      : item.binaryPosition
                                                                            .redeemedPayout,
                                                              )
                                                            : "--"}
                                                    </small>
                                                </div>
                                                <div className="history-accordion-field">
                                                    <span>Claimed</span>
                                                    <small>
                                                        {item.binaryPosition?.status === "Claimed"
                                                            ? "Yes"
                                                            : "No"}
                                                    </small>
                                                </div>
                                                <div className="history-accordion-field">
                                                    <span>TX / Position ID</span>
                                                    <small>
                                                        {item.actionDigest ? (
                                                            <a
                                                                href={predictBinaryExplorerUrl(
                                                                    item.actionDigest,
                                                                )}
                                                                target="_blank"
                                                                rel="noreferrer"
                                                            >
                                                                {shortDigest(item.actionDigest)}
                                                            </a>
                                                        ) : (
                                                            "--"
                                                        )}
                                                    </small>
                                                </div>
                                                {position?.canRedeem && (
                                                    <div className="history-accordion-claim">
                                                        <button
                                                            type="button"
                                                            className="text-action"
                                                            disabled={redeemingKey === position.key}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                void redeem(position);
                                                            }}
                                                        >
                                                            {redeemingKey === position.key
                                                                ? "Redeeming..."
                                                                : "Claim Payout"}
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        )}
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
