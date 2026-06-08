"use client";

import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PredictRoundMarket } from "@/src/features/predict-round/use-predict-round";
import { formatTokenAmount } from "@/src/lib/plp-sandbox/amounts";
import {
    type MintedPositionEvent,
    queryManagerPositionRedeemedEvents,
    queryWalletPositionMintedEvents,
    type RedeemedPositionEvent,
    readDigest,
    readRedeemEvent,
} from "@/src/lib/predict-binary/client";
import { PREDICT_BINARY_CONFIG, predictBinaryExplorerUrl } from "@/src/lib/predict-binary/config";
import { formatBinaryOddsFromQuantity } from "@/src/lib/predict-binary/odds";
import {
    createClaimBinaryPayoutTransaction,
    describeClaimBinaryPayoutMoveCalls,
} from "@/src/lib/predict-binary/transactions";
import {
    isWalletUserRejection,
    readWalletCancellationDebug,
    readWalletErrorMessage,
} from "@/src/lib/wallet-errors";

type BinarySide = "UP" | "DOWN";
type BinaryPositionStatus =
    | "Open"
    | "Redeemable"
    | "Claimed"
    | "Redeemed to Manager"
    | "Lost"
    | "Settlement pending"
    | "Status unknown";

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
    redeemed: RedeemedPositionEvent[];
    claimedKeys: string[];
    mintedPagesRead: number;
    redeemedPagesRead: number;
    reachedLimit: boolean;
}

const MINTED_EVENT_MAX_PAGES = 40;
const REDEEMED_EVENT_MAX_PAGES = 40;
const EVENT_PAGE_SIZE = 50;

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

function settledPriceForPosition(
    position: Pick<PortfolioPosition, "oracleId" | "expiryMs">,
    roundMarket: PredictRoundMarket | null,
): bigint | null {
    const candidates = [
        roundMarket?.previousOracle ?? null,
        roundMarket?.currentOracle ?? null,
    ].filter((value) => value !== null);
    const oracle = candidates.find(
        (candidate) =>
            candidate.oracleId === position.oracleId && candidate.expiryMs === position.expiryMs,
    );
    if (!oracle || oracle.lifecycle !== "settled" || !("settlementPriceRaw" in oracle)) {
        return null;
    }
    return oracle.settlementPriceRaw ? BigInt(oracle.settlementPriceRaw) : null;
}

function buildPositions({
    minted,
    redeemed,
    claimedKeys,
    roundMarket,
    historyComplete,
}: {
    minted: MintedPositionEvent[];
    redeemed: RedeemedPositionEvent[];
    claimedKeys: string[];
    roundMarket: PredictRoundMarket | null;
    historyComplete: boolean;
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
                status: "Status unknown",
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
        position.settlementPrice = settledPriceForPosition(position, roundMarket);
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
            position.status = "Redeemed to Manager";
            position.canRedeem = false;
            continue;
        }
        if (nowMs < position.expiryMs) {
            position.status = "Open";
            position.canRedeem = false;
            continue;
        }
        if (position.settlementPrice === null) {
            position.status = "Settlement pending";
            position.canRedeem = false;
            continue;
        }
        const won = position.isUp
            ? position.settlementPrice > position.strike
            : position.settlementPrice <= position.strike;
        if (!won) {
            position.status = "Lost";
            position.canRedeem = false;
            continue;
        }
        position.status = position.redeemManagerId ? "Redeemable" : "Status unknown";
        position.canRedeem = Boolean(position.redeemManagerId) && position.redeemQuantity > 0n;
        if (position.canRedeem && !historyComplete) {
            position.status = "Status unknown";
            position.canRedeem = false;
        }
    }

    return [...grouped.values()].sort((left, right) => right.expiryMs - left.expiryMs);
}

function isCurrentPosition(position: PortfolioPosition): boolean {
    return (
        position.status === "Open" ||
        position.status === "Settlement pending" ||
        position.status === "Status unknown"
    );
}

function statusClass(status: BinaryPositionStatus): string {
    if (status === "Lost" || status === "Redeemed to Manager" || status === "Claimed") {
        return "is-muted";
    }
    if (status === "Redeemable") {
        return "is-actionable";
    }
    return "";
}

function payoutLabel(position: PortfolioPosition | null): string {
    if (!position) {
        return "--";
    }
    if (position.status === "Lost") {
        return "0 DUSDC";
    }
    if (
        position.status === "Redeemable" ||
        position.status === "Redeemed to Manager" ||
        position.status === "Claimed"
    ) {
        return formatDUSDC(position.totalQuantity);
    }
    return "--";
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

function readResultBalanceChanges(payload: unknown): unknown {
    if (!isRecord(payload) || !isRecord(payload.result)) {
        return null;
    }
    return payload.result.balanceChanges ?? null;
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

async function fetchHasWalletDusdcClaim(digest: string, walletAddress: string): Promise<boolean> {
    const response = await fetch(PREDICT_BINARY_CONFIG.fullnodeJsonRpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: digest,
            method: "sui_getTransactionBlock",
            params: [
                digest,
                {
                    showBalanceChanges: true,
                    showEffects: true,
                },
            ],
        }),
    });
    if (!response.ok) {
        return false;
    }
    const payload = await response.json();
    return (
        isSuccessfulTransactionResult(isRecord(payload) ? payload.result : null) &&
        hasPositiveWalletDusdcBalanceChange(readResultBalanceChanges(payload), walletAddress)
    );
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

    const refresh = useCallback(async () => {
        if (!address) {
            setState(null);
            setError(null);
            setMessage(null);
            return;
        }
        setIsLoading(true);
        setError(null);
        try {
            const mintedResult = await queryWalletPositionMintedEvents({
                trader: address,
                predictId: PREDICT_BINARY_CONFIG.predictObjectId,
                quoteCoinType: PREDICT_BINARY_CONFIG.quoteCoinType,
                maxPages: MINTED_EVENT_MAX_PAGES,
                pageSize: EVENT_PAGE_SIZE,
            });
            const managerIds = [...new Set(mintedResult.events.map((event) => event.managerId))];
            const redeemedResults = await Promise.all(
                managerIds.map((managerId) =>
                    queryManagerPositionRedeemedEvents({
                        managerId,
                        maxPages: REDEEMED_EVENT_MAX_PAGES,
                        pageSize: EVENT_PAGE_SIZE,
                    }),
                ),
            );
            const redeemed = redeemedResults.flatMap((result) => result.events);
            const claimedChecks = await Promise.all(
                redeemed.map(async (event) => {
                    if (!event.digest) {
                        return null;
                    }
                    const hasWalletClaim = await fetchHasWalletDusdcClaim(event.digest, address);
                    return hasWalletClaim ? positionKey(event) : null;
                }),
            );
            setState({
                minted: mintedResult.events,
                redeemed,
                claimedKeys: claimedChecks.filter((key) => key !== null),
                mintedPagesRead: mintedResult.pagesRead,
                redeemedPagesRead: redeemedResults.reduce(
                    (total, result) => total + result.pagesRead,
                    0,
                ),
                reachedLimit:
                    mintedResult.reachedLimit ||
                    redeemedResults.some((result) => result.reachedLimit),
            });
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
                roundMarket,
                historyComplete: state ? !state.reachedLimit : false,
            }),
        [roundMarket, state],
    );
    const currentPositions = useMemo(() => positions.filter(isCurrentPosition), [positions]);
    const positionByKey = useMemo(
        () => new Map(positions.map((position) => [position.key, position])),
        [positions],
    );
    const history = useMemo(
        () =>
            [...(state?.minted ?? [])].sort(
                (left, right) => (right.timestampMs ?? 0) - (left.timestampMs ?? 0),
            ),
        [state],
    );
    const historyActionKeys = useMemo(() => {
        const keys = new Set<string>();
        for (const event of history) {
            const key = positionKey(event);
            const position = positionByKey.get(key);
            if (position?.canRedeem) {
                keys.add(key);
            }
        }
        return keys;
    }, [history, positionByKey]);

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
                ) : currentPositions.length === 0 ? (
                    <div className="empty-state">
                        No current BTC Binary positions found in fetched events.
                    </div>
                ) : (
                    <div className="binary-position-table">
                        {currentPositions.map((position) => (
                            <article key={position.key}>
                                <div>
                                    <span>Market</span>
                                    <strong>BTC</strong>
                                </div>
                                <div>
                                    <span>Type</span>
                                    <strong>Binary</strong>
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
                                    <strong>{formatStrike(position.strike)}</strong>
                                </div>
                                <div>
                                    <span>Expiry</span>
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
                    {state ? `, ${state.mintedPagesRead} mint pages read` : ""}.
                    {state?.reachedLimit ? " Fetch limit reached; more history may exist." : ""}
                </p>
                {message ? <p className="binary-portfolio-note">{message}</p> : null}
            </section>

            <section className="surface binary-portfolio-panel">
                <div className="section-title">
                    <div>
                        <span>BTC Binary</span>
                        <h2>Your history</h2>
                    </div>
                    <strong>{history.length} records</strong>
                </div>
                {history.length === 0 ? (
                    <div className="empty-state">No PositionMinted history in fetched events.</div>
                ) : (
                    <div className="binary-history-list">
                        {history.map((event) => {
                            const digest = event.digest;
                            const groupKey = positionKey(event);
                            const position = positionByKey.get(groupKey) ?? null;
                            const canShowRedeem =
                                Boolean(position?.canRedeem) &&
                                historyActionKeys.has(groupKey) &&
                                !renderedActionKeys.has(groupKey);
                            if (canShowRedeem) {
                                renderedActionKeys.add(groupKey);
                            }
                            const key =
                                digest ??
                                [
                                    event.oracleId,
                                    event.expiryMs.toString(),
                                    event.strike.toString(),
                                    event.isUp ? "UP" : "DOWN",
                                    event.quantity.toString(),
                                    event.cost.toString(),
                                    event.timestampMs?.toString() ?? "no-time",
                                ].join(":");
                            return (
                                <article
                                    key={key}
                                    className={position ? statusClass(position.status) : ""}
                                >
                                    <div>
                                        <span>Date</span>
                                        <strong>{formatDateTime(event.timestampMs)}</strong>
                                    </div>
                                    <div>
                                        <span>Type</span>
                                        <strong>Binary</strong>
                                    </div>
                                    <div>
                                        <span>Side</span>
                                        <strong
                                            className={`binary-side ${event.isUp ? "up" : "down"}`}
                                        >
                                            {event.isUp ? "UP" : "DOWN"}
                                        </strong>
                                    </div>
                                    <div>
                                        <span>Odds</span>
                                        <strong>
                                            {formatBinaryOddsFromQuantity(
                                                event.quantity,
                                                event.cost,
                                            )}
                                        </strong>
                                    </div>
                                    <div>
                                        <span>Bet</span>
                                        <strong>{formatDUSDC(event.cost)}</strong>
                                    </div>
                                    <div>
                                        <span>Payout</span>
                                        <strong>{payoutLabel(position)}</strong>
                                    </div>
                                    <div>
                                        <span>Status</span>
                                        <strong>{position?.status ?? "Unknown"}</strong>
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
                                        ) : position?.status === "Redeemed to Manager" ? (
                                            <span>Withdraw needed</span>
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
                )}
            </section>
        </section>
    );
}
