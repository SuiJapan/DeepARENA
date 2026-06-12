"use client";

import { useEffect, useRef, useState } from "react";
import { RankingSection } from "@/src/features/deep-arena/ranking-section";
import { useDeepArena } from "@/src/features/deep-arena/use-deep-arena";
import { MarketChart } from "@/src/features/market/market-chart";
import { useMarketStream } from "@/src/features/market/use-market-stream";
import { PlpSandboxPanel } from "@/src/features/plp-sandbox/plp-sandbox-panel";
import { BinaryPortfolioSection } from "@/src/features/predict-binary/binary-portfolio-section";
import { PredictBinaryCard } from "@/src/features/predict-binary/predict-binary-card";
import { usePredictRange } from "@/src/features/predict-range/use-predict-range";
import {
    type PredictRoundMarket,
    usePredictRound,
} from "@/src/features/predict-round/use-predict-round";
import { deepArenaMockConfig } from "@/src/lib/deep-arena/config";
import type { PlayerSummary, TokenAmount } from "@/src/lib/deep-arena/types";
import { formatMarketPrice, marketConfig } from "@/src/lib/market/config";
import { WalletStatus } from "./wallet-status";

type View = "arena" | "portfolio" | "ranking";

function formatAmount(amount: TokenAmount, maximumFractionDigits = 2): string {
    const value = Number(amount.atomic) / 10 ** amount.decimals;
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value)} ${amount.symbol}`;
}

function shortId(value: string): string {
    return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function formatRawPredictPrice(value: string | null): string {
    if (value === null) {
        return "--";
    }
    const raw = BigInt(value);
    const scale = 1_000_000_000n;
    const price = Number(raw / scale) + Number(raw % scale) / Number(scale);
    return formatMarketPrice(price);
}

function formatJstDateTime(ms: number | null): string {
    if (ms === null) {
        return "--";
    }
    return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Tokyo",
        timeZoneName: "short",
    })
        .format(new Date(ms))
        .toUpperCase();
}

function RoundProgressBar({ progressPercent }: { progressPercent: number }) {
    return (
        <div
            className="round-progress"
            role="progressbar"
            aria-label="Live round progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercent}
        >
            <span style={{ width: `${progressPercent}%` }} />
        </div>
    );
}

function LiveRoundPanel({
    roundMarket,
    progressPercent,
    currentPrice,
}: {
    roundMarket: PredictRoundMarket | null;
    progressPercent: number;
    currentPrice: number | null;
}) {
    const [displayMarket, setDisplayMarket] = useState<PredictRoundMarket | null>(roundMarket);
    useEffect(() => {
        if (!roundMarket) {
            return;
        }
        if (roundMarket.round && roundMarket.currentOracle) {
            setDisplayMarket(roundMarket);
            return;
        }
        setDisplayMarket((current) => current ?? roundMarket);
    }, [roundMarket]);

    const round = displayMarket?.round ?? null;
    const currentOracle = displayMarket?.currentOracle ?? null;
    const stateLabel =
        displayMarket?.state === "BETTING_OPEN"
            ? "BETTING OPEN"
            : displayMarket?.state === "FINAL_LIVE"
              ? "FINAL LIVE"
              : displayMarket?.state === "LOCKING_ROUND"
                ? "LOCKING ROUND"
                : displayMarket?.state === "ROUND_LOCK_ERROR"
                  ? "ROUND UNAVAILABLE"
                  : displayMarket?.state === "ROUND_DATA_ERROR"
                    ? "ROUND DATA ERROR"
                    : "NO ACTIVE ROUND";

    return (
        <section className="arena-band live-round-panel">
            <div className="live-round-main">
                <div className="live-round-label">
                    <span className="live-dot" />
                    <strong>BTC</strong>
                    <small>{stateLabel}</small>
                    <small>
                        {currentOracle ? shortId(currentOracle.oracleId) : "NO ACTIVE ROUND"}
                    </small>
                </div>
                <div className="live-round-content">
                    <div>
                        <span>Market</span>
                        <h1>BTC</h1>
                    </div>
                    <div className="strike-price">
                        <span>CURRENT PRICE</span>
                        <strong>
                            {currentPrice !== null ? formatMarketPrice(currentPrice) : "--"}
                        </strong>
                    </div>
                    <div className="strike-price">
                        <span>REFERENCE STRIKE</span>
                        <strong>{formatRawPredictPrice(round?.binaryStrikeRaw ?? null)}</strong>
                    </div>
                    <div className="strike-price">
                        <span>SETTLES</span>
                        <strong>{formatJstDateTime(currentOracle?.expiryMs ?? null)}</strong>
                    </div>
                </div>
                <RoundProgressBar progressPercent={progressPercent} />
            </div>
        </section>
    );
}

function NextRangeRoundCard({ roundMarket }: { roundMarket: PredictRoundMarket | null }) {
    const range = usePredictRange(roundMarket);
    const displayDebugKeyRef = useRef<string | null>(null);
    useEffect(() => {
        if (process.env.NODE_ENV === "production") {
            return;
        }
        const debugKey = JSON.stringify(range.displayDebug);
        if (displayDebugKeyRef.current === debugKey) {
            return;
        }
        displayDebugKeyRef.current = debugKey;
        console.info("Range card display state", range.displayDebug);
    }, [range.displayDebug]);
    const statusMessage =
        range.txStatus === "FAILED" ||
        range.txStatus === "SUBMITTING" ||
        range.txStatus === "CONFIRM IN WALLET"
            ? range.message
            : range.direction === "BREAK"
              ? (range.breakPayoutLabel ?? "BREAK is a two-leg position: lower DOWN and upper UP.")
              : range.expectedPayout
                ? `Max payout ${range.expectedPayout}`
                : (range.unavailableReason ?? range.message);

    return (
        <section className="trade-card range next-range-card">
            <div className="card-title">
                <div>
                    <span>BTC Break / Range</span>
                    <h2>
                        {marketConfig.displaySymbol} {range.marketLabel}
                    </h2>
                </div>
            </div>
            <fieldset className="direction-picker range-picker">
                <legend>Choose range outcome</legend>
                <button
                    type="button"
                    className="range-choice range-choice-range"
                    data-active={range.direction === "RANGE"}
                    aria-pressed={range.direction === "RANGE"}
                    disabled={!range.isBettingOpen}
                    onClick={() => range.setDirection("RANGE")}
                >
                    <span>RANGE</span>
                    <strong>{range.rangeOdds}</strong>
                </button>
                <button
                    type="button"
                    className="range-choice range-choice-break"
                    data-active={range.direction === "BREAK"}
                    aria-pressed={range.direction === "BREAK"}
                    disabled={!range.isBettingOpen}
                    onClick={() => range.setDirection("BREAK")}
                >
                    <span>BREAK</span>
                    <strong>{range.breakOdds}</strong>
                </button>
                {range.activePositionDirection ? (
                    <>
                        {range.activePositionDirection === "RANGE" ? (
                            <div className="binary-position-chip position-range">
                                <span>YOUR BET</span>
                                <strong>{range.activePositionCostLabel}</strong>
                                {range.activePositionEntryOdds ? (
                                    <em>Entry {range.activePositionEntryOdds}</em>
                                ) : null}
                            </div>
                        ) : (
                            <div className="binary-position-chip position-empty" aria-hidden />
                        )}
                        {range.activePositionDirection === "BREAK" ? (
                            <div className="binary-position-chip position-break">
                                <span>YOUR BET</span>
                                <strong>{range.activePositionCostLabel}</strong>
                                {range.activePositionEntryOdds ? (
                                    <em>Entry {range.activePositionEntryOdds}</em>
                                ) : null}
                            </div>
                        ) : (
                            <div className="binary-position-chip position-empty" aria-hidden />
                        )}
                    </>
                ) : null}
            </fieldset>
            <label className="binary-amount">
                <span>Amount</span>
                <div>
                    <input
                        type="number"
                        min="0"
                        step="1"
                        value={range.amount}
                        disabled={!range.isBettingOpen}
                        onChange={(event) => range.setAmount(event.target.value)}
                    />
                    <strong>DUSDC</strong>
                </div>
            </label>
            <button
                type="button"
                className="binary-enter-button"
                disabled={!range.canEnter}
                onClick={() => void range.placeRangeBet()}
            >
                Enter Range
            </button>
            <div className="binary-entry-status" aria-live="polite">
                {range.activePositionDirection && range.activePositionCostLabel ? (
                    <>
                        <span>YOUR PICK {range.activePositionDirection}</span>
                        <span>BET {range.activePositionCostLabel}</span>
                        {range.activePositionEntryOdds ? (
                            <span>ENTRY ODDS {range.activePositionEntryOdds}</span>
                        ) : null}
                    </>
                ) : range.txStatus === "FAILED" ? (
                    <span>{range.message}</span>
                ) : (
                    statusMessage
                )}
            </div>
        </section>
    );
}

function LeaderboardSkeleton() {
    return (
        <section className="surface leaderboard">
            <div className="section-title">
                <div>
                    <span>Live standings</span>
                    <h2>Leaderboard</h2>
                </div>
            </div>
            <div className="leader-list" aria-busy="true">
                {[1, 2, 3].map((n) => (
                    <div className="leader-row skeleton" key={n} />
                ))}
            </div>
        </section>
    );
}

function Leaderboard({
    players,
    currentScore,
}: {
    players: PlayerSummary[];
    currentScore?: string;
}) {
    return (
        <section className="surface leaderboard">
            <div className="section-title">
                <div>
                    <span>Live standings</span>
                    <h2>Leaderboard</h2>
                </div>
                {currentScore ? <strong>{currentScore}</strong> : null}
            </div>
            <div className="leader-list">
                {players.map((player) => (
                    <div
                        className="leader-row"
                        data-current={player.isCurrentPlayer}
                        key={player.address}
                    >
                        <span className="leader-rank">{player.rank}</span>
                        <span className="leader-name">
                            <strong>{player.displayName}</strong>
                            <small>{player.address}</small>
                        </span>
                        <strong>{formatAmount(player.score)}</strong>
                    </div>
                ))}
            </div>
        </section>
    );
}

function HomeContent() {
    const [view, setView] = useState<View>("arena");
    const { snapshot, error } = useDeepArena();
    const predictRound = usePredictRound();
    const market = useMarketStream(predictRound.market?.currentOracle?.oracleId ?? null);

    const players = snapshot?.players ?? null;

    return (
        <main className="app-shell">
            <header className="app-header">
                <button className="brand" type="button" onClick={() => setView("arena")}>
                    <span className="brand-mark">DA</span>
                    <strong>Deep Arena</strong>
                </button>
                <nav aria-label="Primary navigation">
                    {(["arena", "portfolio", "ranking"] as const).map((item) => (
                        <button
                            type="button"
                            data-active={view === item}
                            key={item}
                            onClick={() => setView(item)}
                        >
                            {item}
                        </button>
                    ))}
                </nav>
                <div
                    className="wallet-button-wrap"
                    title={`Predict UI mode: ${deepArenaMockConfig.network}`}
                >
                    <WalletStatus />
                </div>
            </header>

            {error ? <div className="error-banner">{error}</div> : null}

            {view === "arena" ? (
                <>
                    <LiveRoundPanel
                        roundMarket={predictRound.market}
                        progressPercent={predictRound.progressPercent}
                        currentPrice={market.reference.currentPrice}
                    />

                    <section className="arena-content">
                        <div className="trade-card-row">
                            <PredictBinaryCard
                                countdownLabel={predictRound.countdownLabel}
                                roundMarket={predictRound.market}
                                spotTimestampMs={market.reference.updatedAtMs}
                            />
                            <NextRangeRoundCard roundMarket={predictRound.market} />
                            <PlpSandboxPanel />
                        </div>
                        <div className="market-ranking-row">
                            <MarketChart
                                binaryStrikeRaw={
                                    predictRound.market?.round?.binaryStrikeRaw ?? null
                                }
                                market={market}
                            />
                            {players !== null ? (
                                <Leaderboard players={players} />
                            ) : (
                                <LeaderboardSkeleton />
                            )}
                        </div>
                    </section>
                </>
            ) : null}

            {view === "portfolio" ? (
                <section className="page-view">
                    <div className="page-heading">
                        <span>Personal account</span>
                        <h1>Portfolio</h1>
                    </div>
                    <BinaryPortfolioSection roundMarket={predictRound.market} />
                </section>
            ) : null}

            {view === "ranking" ? (
                <section className="page-view">
                    <div className="page-heading">
                        <span>Competition overview</span>
                        <h1>Ranking</h1>
                        <p>Track the leaderboard and activity across the full arena.</p>
                    </div>
                    <RankingSection />
                </section>
            ) : null}
        </main>
    );
}

export default function Home() {
    return <HomeContent />;
}
