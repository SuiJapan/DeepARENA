"use client";

import { useEffect, useMemo, useState } from "react";
import { useDeepArena } from "@/src/features/deep-arena/use-deep-arena";
import { deepArenaMockConfig } from "@/src/lib/deep-arena/config";
import type { EventLog, PlayerSummary, TokenAmount } from "@/src/lib/deep-arena/types";

type View = "arena" | "portfolio" | "ranking";
type BinaryDirection = "UP" | "DOWN";
type RangeDirection = "RANGE" | "BREAK";

const liveRound = {
    roundId: "SUI-ROUND-001",
    symbol: "SUI / DUSDC",
    status: "LIVE ROUND",
    strikePrice: "4.0000",
    durationSeconds: 300,
    remainingSeconds: 224,
};

const nextRound = {
    roundId: "SUI-ROUND-002",
    symbol: "SUI / DUSDC",
    odds: "2x",
    defaultAmount: 100,
};

const nextRangeRound = {
    roundId: "SUI-RANGE-ROUND-002",
    symbol: "SUI / DUSDC",
    lowerPrice: "3.9500",
    upperPrice: "4.0500",
    odds: "2x",
    defaultAmount: 100,
};

function formatAmount(amount: TokenAmount, maximumFractionDigits = 2): string {
    const value = Number(amount.atomic) / 10 ** amount.decimals;
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value)} ${amount.symbol}`;
}

function shortId(value: string): string {
    return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function formatCountdown(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function RoundProgressBar({
    remainingSeconds,
    durationSeconds,
}: {
    remainingSeconds: number;
    durationSeconds: number;
}) {
    const progressPercent = (remainingSeconds / durationSeconds) * 100;

    return (
        <div
            className="round-progress"
            role="progressbar"
            aria-label="Live round time remaining"
            aria-valuemin={0}
            aria-valuemax={durationSeconds}
            aria-valuenow={remainingSeconds}
        >
            <span style={{ width: `${progressPercent}%` }} />
        </div>
    );
}

function LiveRoundPanel({
    remainingSeconds,
    prize,
    deadline,
}: {
    remainingSeconds: number;
    prize: TokenAmount;
    deadline: Date;
}) {
    return (
        <section className="arena-band live-round-panel">
            <div className="live-round-main">
                <div className="live-round-label">
                    <span className="live-dot" />
                    <strong>{liveRound.status}</strong>
                    <small>{liveRound.roundId}</small>
                </div>
                <div className="live-round-content">
                    <div>
                        <span>Market</span>
                        <h1>{liveRound.symbol}</h1>
                    </div>
                    <div className="round-countdown">
                        <span>Time remaining</span>
                        <strong>{formatCountdown(remainingSeconds)}</strong>
                    </div>
                    <div className="strike-price">
                        <span>Strike price</span>
                        <strong>{liveRound.strikePrice}</strong>
                    </div>
                </div>
                <RoundProgressBar
                    remainingSeconds={remainingSeconds}
                    durationSeconds={liveRound.durationSeconds}
                />
            </div>
            <div className="arena-prize">
                <span>Total prize</span>
                <strong>{formatAmount(prize)}</strong>
            </div>
            <div className="arena-deadline">
                <span>Local deadline</span>
                <strong>
                    {deadline.toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                    })}
                </strong>
                <small>
                    {deadline.toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZoneName: "short",
                    })}
                </small>
            </div>
        </section>
    );
}

function NextBinaryRoundCard() {
    const [direction, setDirection] = useState<BinaryDirection | null>(null);
    const [amount, setAmount] = useState(String(nextRound.defaultAmount));
    const [entryMessage, setEntryMessage] = useState<string | null>(null);
    const amountNumber = Number(amount);
    const canEnter = direction !== null && Number.isFinite(amountNumber) && amountNumber > 0;

    function enterNextRound() {
        if (!direction || !canEnter) {
            return;
        }

        console.log({
            direction,
            amount: amountNumber,
            roundId: nextRound.roundId,
        });
        setEntryMessage(`${direction} entry queued for ${amountNumber} DUSDC`);
    }

    return (
        <section className="trade-card binary next-binary-card">
            <div className="card-title">
                <div>
                    <span>Binary · Next round</span>
                    <h2>{nextRound.symbol}</h2>
                </div>
            </div>
            <fieldset className="direction-picker">
                <legend>Choose prediction direction</legend>
                <button
                    type="button"
                    className="direction-up"
                    data-active={direction === "UP"}
                    aria-pressed={direction === "UP"}
                    onClick={() => setDirection("UP")}
                >
                    <span>UP</span>
                    <strong>{nextRound.odds}</strong>
                </button>
                <button
                    type="button"
                    className="direction-down"
                    data-active={direction === "DOWN"}
                    aria-pressed={direction === "DOWN"}
                    onClick={() => setDirection("DOWN")}
                >
                    <span>DOWN</span>
                    <strong>{nextRound.odds}</strong>
                </button>
            </fieldset>
            <label className="binary-amount">
                <span>Amount</span>
                <div>
                    <input
                        type="number"
                        min="0"
                        step="1"
                        value={amount}
                        onChange={(event) => {
                            setAmount(event.target.value);
                            setEntryMessage(null);
                        }}
                    />
                    <strong>DUSDC</strong>
                </div>
            </label>
            <button
                type="button"
                className="binary-enter-button"
                disabled={!canEnter}
                onClick={enterNextRound}
            >
                Enter Next Round
            </button>
            <div className="binary-entry-status" aria-live="polite">
                {entryMessage ?? "Choose UP or DOWN to enter the next five-minute round."}
            </div>
        </section>
    );
}

function NextRangeRoundCard() {
    const [direction, setDirection] = useState<RangeDirection>("RANGE");
    const [amount, setAmount] = useState(String(nextRangeRound.defaultAmount));
    const [entryMessage, setEntryMessage] = useState<string | null>(null);
    const amountNumber = Number(amount);
    const canEnter = Number.isFinite(amountNumber) && amountNumber > 0;

    function enterNextRound() {
        if (!canEnter) {
            return;
        }

        console.log({
            direction,
            amount: amountNumber,
            roundId: nextRangeRound.roundId,
        });
        setEntryMessage(`${direction} entry queued for ${amountNumber} DUSDC`);
    }

    return (
        <section className="trade-card range next-range-card">
            <div className="card-title">
                <div>
                    <span>Vertical Range · Next round</span>
                    <h2>
                        {nextRangeRound.symbol} {nextRangeRound.lowerPrice} -{" "}
                        {nextRangeRound.upperPrice}
                    </h2>
                </div>
            </div>
            <fieldset className="direction-picker range-picker">
                <legend>Choose range outcome</legend>
                <button
                    type="button"
                    className="range-choice"
                    data-active={direction === "RANGE"}
                    aria-pressed={direction === "RANGE"}
                    onClick={() => setDirection("RANGE")}
                >
                    <span>RANGE</span>
                    <strong>{nextRangeRound.odds}</strong>
                </button>
                <button
                    type="button"
                    className="range-choice"
                    data-active={direction === "BREAK"}
                    aria-pressed={direction === "BREAK"}
                    onClick={() => setDirection("BREAK")}
                >
                    <span>BREAK</span>
                    <strong>{nextRangeRound.odds}</strong>
                </button>
            </fieldset>
            <label className="binary-amount">
                <span>Amount</span>
                <div>
                    <input
                        type="number"
                        min="0"
                        step="1"
                        value={amount}
                        onChange={(event) => {
                            setAmount(event.target.value);
                            setEntryMessage(null);
                        }}
                    />
                    <strong>DUSDC</strong>
                </div>
            </label>
            <button
                type="button"
                className="binary-enter-button"
                disabled={!canEnter}
                onClick={enterNextRound}
            >
                Enter Next Round
            </button>
            <div className="binary-entry-status" aria-live="polite">
                {entryMessage ?? "Choose RANGE or BREAK for the next five-minute round."}
            </div>
        </section>
    );
}

function PlpCard({
    price,
    change,
    supply,
    liquidity,
    utilization,
}: {
    price: string;
    change: string;
    supply: string;
    liquidity: TokenAmount;
    utilization: string;
}) {
    return (
        <section className="trade-card plp-card">
            <div className="card-title">
                <div>
                    <span>Liquidity provider</span>
                    <h2>Predict PLP</h2>
                </div>
                <strong>{price}</strong>
            </div>
            <div className="plp-highlight">
                <span>PLP price</span>
                <strong>{price} DUSDC</strong>
                <small>+{change}% today</small>
            </div>
            <dl className="plp-facts">
                <div>
                    <dt>Available liquidity</dt>
                    <dd>{formatAmount(liquidity, 0)}</dd>
                </div>
                <div>
                    <dt>Utilization</dt>
                    <dd>{utilization}%</dd>
                </div>
                <div>
                    <dt>Total supply</dt>
                    <dd>{Number(supply).toLocaleString("en-US")}</dd>
                </div>
            </dl>
            <button type="button" className="disabled-action" disabled>
                Liquidity actions unavailable
            </button>
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

function MarketChart() {
    return (
        <section className="surface market-chart">
            <div className="section-title">
                <div>
                    <span>Market view</span>
                    <h2>SUI / DUSDC</h2>
                </div>
                <div className="market-quote">
                    <strong>3.42 DUSDC</strong>
                    <small>+4.18%</small>
                </div>
            </div>
            <div className="timeframe-row">
                <button type="button">1H</button>
                <button type="button" data-active="true">
                    1D
                </button>
                <button type="button">1W</button>
                <button type="button">1M</button>
            </div>
            <div className="chart-area">
                <svg viewBox="0 0 800 260" role="img" aria-label="Illustrative SUI price chart">
                    <defs>
                        <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1">
                            <stop offset="0%" stopColor="#31a98b" stopOpacity="0.28" />
                            <stop offset="100%" stopColor="#31a98b" stopOpacity="0" />
                        </linearGradient>
                    </defs>
                    <path
                        className="chart-fill"
                        d="M0 224 L38 214 L76 219 L114 180 L152 191 L190 145 L228 160 L266 117 L304 128 L342 85 L380 104 L418 76 L456 118 L494 110 L532 149 L570 140 L608 167 L646 137 L684 151 L722 111 L760 124 L800 78 L800 260 L0 260 Z"
                    />
                    <path
                        className="chart-line"
                        d="M0 224 L38 214 L76 219 L114 180 L152 191 L190 145 L228 160 L266 117 L304 128 L342 85 L380 104 L418 76 L456 118 L494 110 L532 149 L570 140 L608 167 L646 137 L684 151 L722 111 L760 124 L800 78"
                    />
                </svg>
                <div className="chart-axis">
                    <span>00:00</span>
                    <span>06:00</span>
                    <span>12:00</span>
                    <span>18:00</span>
                    <span>Now</span>
                </div>
            </div>
        </section>
    );
}

function HistoryTable({ events, title }: { events: EventLog[]; title: string }) {
    return (
        <section className="surface history">
            <div className="section-title">
                <div>
                    <span>Mock activity</span>
                    <h2>{title}</h2>
                </div>
                <strong>{events.length} records</strong>
            </div>
            <div className="history-list">
                {events.map((event) => (
                    <article key={event.id}>
                        <span className={`history-mark ${event.kind}`} />
                        <div>
                            <strong>{event.title}</strong>
                            <p>{event.detail}</p>
                        </div>
                        <small>
                            {new Date(event.timestampMs).toLocaleString("en-US", {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                            })}
                        </small>
                    </article>
                ))}
            </div>
        </section>
    );
}

export default function Home() {
    const [view, setView] = useState<View>("arena");
    const { snapshot, preview, error, isLoading } = useDeepArena();
    const [remainingSeconds, setRemainingSeconds] = useState(liveRound.remainingSeconds);

    const currentPlayer = useMemo(
        () => snapshot?.players.find(({ isCurrentPlayer }) => isCurrentPlayer),
        [snapshot],
    );

    useEffect(() => {
        const intervalId = window.setInterval(() => {
            setRemainingSeconds((current) =>
                current <= 1 ? liveRound.durationSeconds : current - 1,
            );
        }, 1000);

        return () => window.clearInterval(intervalId);
    }, []);

    if (isLoading || !snapshot) {
        return <main className="status-screen">Loading Deep Arena mock...</main>;
    }

    const { arena, players, vault, plp, events } = snapshot;
    const ownEvents = events.filter(({ actor }) => actor === currentPlayer?.address);
    const endsAt = new Date(arena.endMs);

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
                <button
                    className="wallet-button"
                    type="button"
                    title={`Wallet connection is unavailable in ${deepArenaMockConfig.network} mode`}
                    disabled
                >
                    Connect wallet
                </button>
            </header>

            {error ? <div className="error-banner">{error}</div> : null}

            {view === "arena" ? (
                <>
                    <LiveRoundPanel
                        remainingSeconds={remainingSeconds}
                        prize={arena.prizePool}
                        deadline={endsAt}
                    />

                    <section className="arena-content">
                        <div className="trade-card-row">
                            <NextBinaryRoundCard />
                            <NextRangeRoundCard />
                            <PlpCard
                                price={plp.priceInQuote}
                                change={plp.dayChangePercent}
                                supply={plp.totalSupply}
                                liquidity={vault.availableLiquidity}
                                utilization={vault.utilizationPercent}
                            />
                        </div>
                        <div className="market-ranking-row">
                            <MarketChart />
                            <Leaderboard players={players} />
                        </div>
                    </section>
                </>
            ) : null}

            {view === "portfolio" ? (
                <section className="page-view">
                    <div className="page-heading">
                        <span>Personal account</span>
                        <h1>Portfolio</h1>
                        <p>Review your current mock exposure and your own activity.</p>
                    </div>
                    <div className="portfolio-summary">
                        <div>
                            <span>Current score</span>
                            <strong>
                                {currentPlayer ? formatAmount(currentPlayer.score) : "Unavailable"}
                            </strong>
                        </div>
                        <div>
                            <span>Arena rank</span>
                            <strong>#{currentPlayer?.rank ?? "-"}</strong>
                        </div>
                        <div>
                            <span>Predict manager</span>
                            <strong>
                                {currentPlayer ? shortId(currentPlayer.predictManagerId) : "-"}
                            </strong>
                        </div>
                    </div>
                    <section className="surface positions">
                        <div className="section-title">
                            <div>
                                <span>Current exposure</span>
                                <h2>Open mock positions</h2>
                            </div>
                        </div>
                        {preview ? (
                            <div className="position-row">
                                <span className={`position-kind ${preview.kind}`}>
                                    {preview.kind}
                                </span>
                                <div>
                                    <strong>{preview.marketLabel}</strong>
                                    <small>{preview.quantity} units</small>
                                </div>
                                <div>
                                    <span>Cost</span>
                                    <strong>{formatAmount(preview.estimatedCost)}</strong>
                                </div>
                                <div>
                                    <span>Max payout</span>
                                    <strong>{formatAmount(preview.estimatedPayout)}</strong>
                                </div>
                            </div>
                        ) : (
                            <div className="empty-state">
                                Preview or open a mock position in Arena to display it here.
                            </div>
                        )}
                    </section>
                    <HistoryTable events={ownEvents} title="Your history" />
                </section>
            ) : null}

            {view === "ranking" ? (
                <section className="page-view">
                    <div className="page-heading">
                        <span>Competition overview</span>
                        <h1>Ranking</h1>
                        <p>Track the leaderboard and activity across the full arena.</p>
                    </div>
                    <div className="ranking-grid">
                        <Leaderboard
                            players={players}
                            currentScore={
                                currentPlayer
                                    ? `Your score ${formatAmount(currentPlayer.score)}`
                                    : undefined
                            }
                        />
                        <HistoryTable events={events} title="Arena history" />
                    </div>
                </section>
            ) : null}
        </main>
    );
}
