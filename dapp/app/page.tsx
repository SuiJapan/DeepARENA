"use client";

import { useEffect, useMemo, useState } from "react";
import { useDeepArena } from "@/src/features/deep-arena/use-deep-arena";
import { MarketChart } from "@/src/features/market/market-chart";
import { useMarketStream } from "@/src/features/market/use-market-stream";
import { PlpSandboxPanel } from "@/src/features/plp-sandbox/plp-sandbox-panel";
import { PredictBinaryCard } from "@/src/features/predict-binary/predict-binary-card";
import {
    type PredictRoundMarket,
    usePredictRound,
} from "@/src/features/predict-round/use-predict-round";
import { deepArenaMockConfig } from "@/src/lib/deep-arena/config";
import type { EventLog, PlayerSummary, TokenAmount } from "@/src/lib/deep-arena/types";
import { calculateMarketRange, formatMarketPrice } from "@/src/lib/market/config";
import { WalletStatus } from "./wallet-status";

type View = "arena" | "portfolio" | "leaderboard" | "how-it-works";
type RangeDirection = "RANGE" | "BREAK";
const arenaPairLabel = "SUI / DUSDC";
const defaultView: View = "arena";

const navViews: Array<{ key: View; label: string }> = [
    { key: "arena", label: "Arena" },
    { key: "portfolio", label: "Portfolio" },
    { key: "leaderboard", label: "Leaderboard" },
    { key: "how-it-works", label: "How It Works" },
];

const arenaAnchors = [
    { targetId: "arena-top", label: "Top" },
    { targetId: "market-flow", label: "Flow" },
    { targetId: "arena-trade", label: "Trade" },
] as const;

const _localModeLabels = [
    "LIVE SIGNAL",
    "MOCK-FIRST",
    "MARKET ARENA",
    "SUI TESTNET READY",
    "LOCAL PREVIEW",
    "NO FLUX REQUIRED",
    "ROUND ACTIVE",
];

const signalPathPoints = [
    [0, 168],
    [72, 140],
    [132, 154],
    [198, 104],
    [262, 128],
    [326, 78],
    [398, 96],
    [470, 52],
    [536, 70],
    [612, 34],
    [682, 66],
    [760, 28],
] as const;

const signalAreaPath = `M ${signalPathPoints.map(([x, y]) => `${x} ${y}`).join(" L ")} L 760 220 L 0 220 Z`;
const signalLinePath = `M ${signalPathPoints.map(([x, y]) => `${x} ${y}`).join(" L ")}`;

const primitiveCards = [
    {
        title: "FLOW",
        body: "Execution routes through the arena.",
        metric: "ROUTE 01",
        label: "signal path",
    },
    {
        title: "DEPTH",
        body: "Liquidity pressure and market surface.",
        metric: "PRESSURE",
        label: "book surface",
    },
    {
        title: "PROOF",
        body: "Result, receipt, and settlement memory.",
        metric: "RECORD",
        label: "trail",
    },
] as const;

const builderCards = ["Builders", "Traders", "Agents", "Markets", "Storage", "Protocols"];

const systemNodes = [
    { name: "Wallet", detail: "Testnet-ready account layer", state: "ready" },
    { name: "Agent", detail: "Mock route selection", state: "active" },
    { name: "Market", detail: "SUI / DUSDC signal", state: "contested" },
    { name: "Liquidity", detail: "Depth and PLP surface", state: "active" },
    { name: "Memory", detail: "Receipts for later proof", state: "ready" },
    { name: "Settlement", detail: "Live execution can connect later", state: "ready" },
] as const;

const nextRangeRound = {
    roundId: "SUI-RANGE-ROUND-002",
    odds: "2x",
    defaultAmount: 100,
};

type PortfolioPositionSummary = {
    id: string;
    kind: "binary" | "range";
    label: string;
    quantity: string;
    amountLabel: string;
    pnlLabel: string;
    resultLabel: string;
    statusLabel: string;
};

type PortfolioHistorySummary = {
    id: string;
    roundType: string;
    marketLabel: string;
    pnlLabel: string;
    resultLabel: string;
    statusLabel: string;
    settledAtLabel: string;
};

function isView(value: string): value is View {
    return navViews.some((item) => item.key === value);
}

function resolveViewFromHash(hash: string): View {
    const normalized = hash.replace(/^#/, "").toLowerCase();
    return isView(normalized) ? normalized : defaultView;
}

function getViewHash(view: View): string {
    return `#${view}`;
}

function readInitialView(): View {
    if (typeof window === "undefined") {
        return defaultView;
    }
    return resolveViewFromHash(window.location.hash);
}

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

function formatLocalDateTime(ms: number | null): string {
    if (ms === null) {
        return "--";
    }
    return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
    })
        .format(new Date(ms))
        .toUpperCase();
}

function formatDateTime(ms: number): string {
    return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    }).format(new Date(ms));
}

function scrollToSection(targetId: string) {
    if (typeof document === "undefined") {
        return;
    }
    document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function buildActivePosition(
    preview: ReturnType<typeof useDeepArena>["preview"],
    entryAmount: TokenAmount,
): PortfolioPositionSummary {
    if (preview) {
        const estimate =
            Number(preview.estimatedPayout.atomic) - Number(preview.estimatedCost.atomic);
        const pnlAmount = { ...preview.estimatedCost, atomic: estimate.toString() };
        return {
            id: `preview-${preview.marketId}`,
            kind: preview.kind,
            label: preview.marketLabel,
            quantity: `${preview.quantity} units`,
            amountLabel: formatAmount(preview.estimatedCost),
            pnlLabel: `${estimate >= 0 ? "+" : ""}${formatAmount(pnlAmount)}`,
            resultLabel: "Pending",
            statusLabel: "Open",
        };
    }

    return {
        id: "mock-binary-position",
        kind: "binary",
        label: `${arenaPairLabel} hourly binary`,
        quantity: "1.50 units",
        amountLabel: formatAmount({ ...entryAmount, atomic: "120000000" }),
        pnlLabel: "+18.40 DUSDC",
        resultLabel: "Pending",
        statusLabel: "Open",
    };
}

function buildSettledHistory(events: EventLog[]): PortfolioHistorySummary[] {
    const ownSettledEvents = events
        .filter((event) => event.kind === "binary-opened" || event.kind === "range-opened")
        .slice(0, 2)
        .map((event, index) => ({
            id: `event-${event.id}`,
            roundType: event.kind === "binary-opened" ? "Binary" : "Range",
            marketLabel: event.title,
            pnlLabel: index === 0 ? "+12.80 DUSDC" : "-6.20 DUSDC",
            resultLabel: index === 0 ? "Won" : "Lost",
            statusLabel: "Settled",
            settledAtLabel: formatDateTime(event.timestampMs),
        }));

    if (ownSettledEvents.length > 0) {
        return ownSettledEvents;
    }

    return [
        {
            id: "settled-1",
            roundType: "Binary",
            marketLabel: `${arenaPairLabel} close above strike`,
            pnlLabel: "+12.80 DUSDC",
            resultLabel: "Won",
            statusLabel: "Settled",
            settledAtLabel: formatDateTime(Date.now() - 1000 * 60 * 48),
        },
        {
            id: "settled-2",
            roundType: "Range",
            marketLabel: `${arenaPairLabel} stayed in range`,
            pnlLabel: "-6.20 DUSDC",
            resultLabel: "Lost",
            statusLabel: "Settled",
            settledAtLabel: formatDateTime(Date.now() - 1000 * 60 * 180),
        },
    ];
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

function HeroTerminal({
    countdownLabel,
    currentPrice,
    onEnterArena,
    onViewLeaderboard,
    participantCount,
    roundMarket,
    prizePool,
}: {
    countdownLabel: string | null;
    currentPrice: number | null;
    onEnterArena: () => void;
    onViewLeaderboard: () => void;
    participantCount: number;
    roundMarket: PredictRoundMarket | null;
    prizePool: TokenAmount;
}) {
    const round = roundMarket?.round ?? null;
    const currentOracle = roundMarket?.currentOracle ?? null;
    const stateLabel =
        roundMarket?.state === "BETTING_OPEN"
            ? "LIVE ROUND"
            : roundMarket?.state === "FINAL_LIVE"
              ? "FINAL LIVE"
              : roundMarket?.state === "LOCKING_ROUND"
                ? "LOCKING ROUND"
                : roundMarket?.state === "ROUND_LOCK_ERROR"
                  ? "ROUND UNAVAILABLE"
                  : roundMarket?.state === "ROUND_DATA_ERROR"
                    ? "ROUND DATA ERROR"
                    : "NO ACTIVE ROUND";
    return (
        <section className="deep-hero" id="arena-top">
            <div className="hero-copy">
                <span className="hero-kicker">{arenaPairLabel}</span>
                <h2 className="live-round-card-title">Hourly rounds compete live</h2>
                <p>
                    Enter the current prediction round, track the signal in real time, and move for
                    position before settlement.
                </p>
                <div className="round-info-strip">
                    <span title={round?.roundId ?? undefined}>
                        Round {round?.roundId ? shortId(round.roundId) : "--"}
                    </span>
                    <span>Entry closes in {countdownLabel ?? "--:--:--"}</span>
                    <span>Settlement {formatLocalDateTime(currentOracle?.expiryMs ?? null)}</span>
                    <span>Strike {formatRawPredictPrice(round?.binaryStrikeRaw ?? null)}</span>
                </div>
                <div className="hero-actions">
                    <button type="button" onClick={onEnterArena}>
                        Enter Arena
                    </button>
                    <button type="button" onClick={onViewLeaderboard}>
                        View Leaderboard
                    </button>
                </div>
            </div>
            <div className="hero-terminal">
                <div className="terminal-topline">
                    <span>{stateLabel}</span>
                    <strong>
                        {currentPrice !== null ? formatMarketPrice(currentPrice) : "LOCAL"}
                    </strong>
                </div>
                <SignalChart />
                <div className="terminal-metrics">
                    <div>
                        <span>Current price</span>
                        <strong>
                            {currentPrice !== null ? formatMarketPrice(currentPrice) : "--"}
                        </strong>
                    </div>
                    <div>
                        <span>Round state</span>
                        <strong>{stateLabel}</strong>
                    </div>
                    <div>
                        <span>Pool balance</span>
                        <strong>{formatAmount(prizePool, 1)}</strong>
                    </div>
                </div>
                <div className="terminal-foot">
                    <span>Participants {participantCount}</span>
                    <span>Market {arenaPairLabel}</span>
                    <span>Testnet {deepArenaMockConfig.network}</span>
                </div>
            </div>
        </section>
    );
}

function SignalChart() {
    return (
        <div className="signal-chart">
            <svg viewBox="0 0 760 240" role="img" aria-label="Live SUI price signal chart">
                <defs>
                    <linearGradient id="signalArea" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor="#18f0c8" stopOpacity="0.36" />
                        <stop offset="100%" stopColor="#18f0c8" stopOpacity="0" />
                    </linearGradient>
                </defs>
                <path className="signal-grid-line" d="M 0 58 H 760 M 0 116 H 760 M 0 174 H 760" />
                <path className="signal-area" d={signalAreaPath} />
                <path className="signal-line" d={signalLinePath} />
                {signalPathPoints.map(([x, y]) => (
                    <circle className="signal-point" cx={x} cy={y} key={`${x}:${y}`} r="4" />
                ))}
            </svg>
        </div>
    );
}

function ReversalSection() {
    return (
        <section className="reversal-section">
            <div className="reversal-heading">
                <span>ARENA FIELD</span>
                <h2>
                    THE FIELD BETWEEN
                    <br />
                    LIQUIDITY AND APPS
                </h2>
            </div>
            <div className="builder-grid">
                {builderCards.map((item, index) => (
                    <article key={item}>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <strong>{item}</strong>
                    </article>
                ))}
            </div>
        </section>
    );
}

function PrimitiveSection() {
    return (
        <section className="primitive-section">
            {primitiveCards.map((primitive) => (
                <article className="primitive-card" key={primitive.title}>
                    <span>{primitive.label}</span>
                    <h3>{primitive.title}</h3>
                    <p>{primitive.body}</p>
                    <strong>{primitive.metric}</strong>
                </article>
            ))}
        </section>
    );
}

function SystemMap() {
    return (
        <section className="system-map" id="market-flow">
            <div className="system-map-heading">
                <span>MARKET FLOW MAP</span>
                <h2>Execution routes through the arena surface.</h2>
            </div>
            <div className="node-grid">
                {systemNodes.map((node) => (
                    <article className="flow-node" data-state={node.state} key={node.name}>
                        <span />
                        <strong>{node.name}</strong>
                        <p>{node.detail}</p>
                    </article>
                ))}
            </div>
        </section>
    );
}

function LocalModeSection() {
    return (
        <section className="local-mode">
            <div>
                <span>PRE-LIVE MODE</span>
                <h2>Preview the full interface before live data and execution are connected.</h2>
            </div>
            <ul>
                <li>Mock-first rendering</li>
                <li>Sui testnet-ready wallet layer</li>
                <li>LocalStorage fallback</li>
                <li>No FLUX required for preview</li>
                <li>Live infrastructure can be connected later</li>
            </ul>
        </section>
    );
}

function _LiveRoundPanel({
    roundMarket,
    progressPercent,
    currentPrice,
}: {
    roundMarket: PredictRoundMarket | null;
    progressPercent: number;
    currentPrice: number | null;
}) {
    const round = roundMarket?.round ?? null;
    const currentOracle = roundMarket?.currentOracle ?? null;
    const stateLabel =
        roundMarket?.state === "BETTING_OPEN"
            ? "BETTING OPEN"
            : roundMarket?.state === "FINAL_LIVE"
              ? "FINAL LIVE"
              : roundMarket?.state === "LOCKING_ROUND"
                ? "LOCKING ROUND"
                : roundMarket?.state === "ROUND_LOCK_ERROR"
                  ? "ROUND UNAVAILABLE"
                  : roundMarket?.state === "ROUND_DATA_ERROR"
                    ? "ROUND DATA ERROR"
                    : "NO ACTIVE ROUND";

    return (
        <section className="arena-band live-round-panel">
            <div className="live-round-main">
                <div className="live-round-label">
                    <span className="live-dot" />
                    <strong>SUI</strong>
                    <small>{stateLabel}</small>
                    <small>
                        {currentOracle ? shortId(currentOracle.oracleId) : "NO ACTIVE ROUND"}
                    </small>
                </div>
                <div className="arena-stat-strip">
                    <span>CURRENT ROUND</span>
                    <span>SIGNAL DUEL</span>
                    <span>LIQUIDITY PRESSURE</span>
                    <span>ROUND CLOSE</span>
                    <span>MOCK SETTLEMENT</span>
                </div>
                <div className="live-round-content">
                    <div>
                        <span>Market</span>
                        <h1>{arenaPairLabel}</h1>
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
                        <strong>{formatLocalDateTime(currentOracle?.expiryMs ?? null)}</strong>
                    </div>
                </div>
                <RoundProgressBar progressPercent={progressPercent} />
            </div>
        </section>
    );
}

function NextRangeRoundCard({
    currentPrice,
    roundMarket,
}: {
    currentPrice: number | null;
    roundMarket: PredictRoundMarket | null;
}) {
    const [direction, setDirection] = useState<RangeDirection>("RANGE");
    const [amount, setAmount] = useState(String(nextRangeRound.defaultAmount));
    const [entryMessage, setEntryMessage] = useState<string | null>(null);
    const amountNumber = Number(amount);
    const isBettingOpen = roundMarket?.state === "BETTING_OPEN";
    const canEnter = isBettingOpen && Number.isFinite(amountNumber) && amountNumber > 0;
    const range = currentPrice !== null ? calculateMarketRange(currentPrice) : null;

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
                    <span>RANGE</span>
                    <h2>{arenaPairLabel}</h2>
                </div>
            </div>
            <div className="card-subtitle">Pick IN RANGE or BREAK before the round closes.</div>
            <div className="market-facts range-facts">
                <span>Lower strike {range ? formatMarketPrice(range.lower) : "--"}</span>
                <span>Upper strike {range ? formatMarketPrice(range.upper) : "--"}</span>
                <span>
                    Entry closes{" "}
                    {roundMarket?.round
                        ? formatLocalDateTime(roundMarket.round.bettingCloseMs)
                        : "--"}
                </span>
            </div>
            <fieldset className="direction-picker range-picker">
                <legend>Choose range outcome</legend>
                <button
                    type="button"
                    className="range-choice"
                    data-active={direction === "RANGE"}
                    aria-pressed={direction === "RANGE"}
                    disabled={!isBettingOpen}
                    onClick={() => setDirection("RANGE")}
                >
                    <span>IN RANGE</span>
                    <strong>{nextRangeRound.odds}</strong>
                </button>
                <button
                    type="button"
                    className="range-choice"
                    data-active={direction === "BREAK"}
                    aria-pressed={direction === "BREAK"}
                    disabled={!isBettingOpen}
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
                        disabled={!isBettingOpen}
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
                {entryMessage ?? "Choose IN RANGE or BREAK for the next round."}
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
    const leader = players[0] ?? null;
    const currentPlayer = players.find((player) => player.isCurrentPlayer) ?? null;
    const scoreGap =
        leader && currentPlayer
            ? BigInt(leader.score.atomic) - BigInt(currentPlayer.score.atomic)
            : null;
    const scoreGapAmount =
        leader && scoreGap !== null ? { ...leader.score, atomic: scoreGap.toString() } : null;
    return (
        <section className="surface leaderboard">
            <div className="section-title">
                <div>
                    <span>LIVE STANDINGS</span>
                    <h2>Leaderboard</h2>
                    <small>
                        {leader ? `Leader ${leader.displayName}` : "Current leader unavailable"}
                    </small>
                </div>
                {currentScore ? <strong>{currentScore}</strong> : null}
            </div>
            <div className="leader-meta">
                <div>
                    <span>Top contender</span>
                    <strong>{leader ? leader.displayName : "--"}</strong>
                </div>
                <div>
                    <span>Your gap</span>
                    <strong>{scoreGapAmount ? formatAmount(scoreGapAmount) : "--"}</strong>
                </div>
                <div>
                    <span>Your rank</span>
                    <strong>{currentPlayer ? `#${currentPlayer.rank}` : "--"}</strong>
                </div>
            </div>
            <div className="leader-list">
                {players.map((player) => (
                    <div
                        className="leader-row"
                        data-current={player.isCurrentPlayer}
                        data-leader={player.rank === 1}
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

function HomeContent() {
    const [view, setView] = useState<View>(readInitialView);
    const [menuOpen, setMenuOpen] = useState(false);
    const { snapshot, preview, error, isLoading } = useDeepArena();
    const predictRound = usePredictRound();
    const market = useMarketStream(predictRound.market?.currentOracle?.oracleId ?? null);

    const currentPlayer = useMemo(
        () => snapshot?.players.find(({ isCurrentPlayer }) => isCurrentPlayer),
        [snapshot],
    );

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        function syncViewFromHash() {
            const nextView = resolveViewFromHash(window.location.hash);
            setView(nextView);
            setMenuOpen(false);
        }

        syncViewFromHash();
        window.addEventListener("hashchange", syncViewFromHash);
        return () => window.removeEventListener("hashchange", syncViewFromHash);
    }, []);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        const nextHash = getViewHash(view);
        if (window.location.hash !== nextHash) {
            window.history.replaceState(null, "", nextHash);
        }
    }, [view]);

    if (isLoading || !snapshot) {
        return <main className="status-screen">Loading Deep Arena mock...</main>;
    }

    const { players, events } = snapshot;
    const ownEvents = events.filter(({ actor }) => actor === currentPlayer?.address);
    const activePosition = buildActivePosition(preview, snapshot.arena.entryAmount);
    const settledHistory = buildSettledHistory(ownEvents);

    function selectView(nextView: View) {
        setMenuOpen(false);
        if (typeof window === "undefined") {
            setView(nextView);
            return;
        }

        const nextHash = getViewHash(nextView);
        if (window.location.hash === nextHash) {
            setView(nextView);
            return;
        }
        window.location.hash = nextView;
    }

    return (
        <main className="app-shell">
            <header className="app-header">
                <button className="brand" type="button" onClick={() => selectView("arena")}>
                    <span className="brand-mark">DA</span>
                    <strong>Deep Arena</strong>
                </button>
                <button
                    aria-controls="primary-navigation"
                    aria-expanded={menuOpen}
                    aria-label="Toggle navigation"
                    className="menu-button"
                    type="button"
                    onClick={() => setMenuOpen((value) => !value)}
                >
                    <span />
                    <span />
                    <span />
                </button>
                <nav id="primary-navigation" aria-label="Primary navigation" data-open={menuOpen}>
                    {navViews.map((item) => (
                        <button
                            type="button"
                            data-active={view === item.key}
                            key={item.key}
                            onClick={() => selectView(item.key)}
                        >
                            {item.label}
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

            {menuOpen ? (
                <div className="drawer-panel" role="dialog" aria-label="Quick navigation">
                    <div className="drawer-group">
                        {navViews.map((item) => (
                            <button
                                key={item.key}
                                type="button"
                                data-active={view === item.key}
                                onClick={() => selectView(item.key)}
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>
                    {view === "arena" ? (
                        <div className="drawer-group drawer-anchor-group">
                            {arenaAnchors.map((item) => (
                                <button
                                    key={item.targetId}
                                    type="button"
                                    onClick={() => {
                                        setMenuOpen(false);
                                        scrollToSection(item.targetId);
                                    }}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                    ) : null}
                    <div className="drawer-group drawer-wallet-group">
                        <WalletStatus />
                    </div>
                </div>
            ) : null}

            {view === "arena" ? (
                <section className="page-view arena-page-view">
                    <div className="page-heading page-heading-arena">
                        <span>Live Round</span>
                        <h1>Arena</h1>
                        <p>
                            Enter the current SUI / DUSDC prediction round, monitor the live signal,
                            and compete for position on the leaderboard.
                        </p>
                    </div>
                    <HeroTerminal
                        countdownLabel={predictRound.countdownLabel}
                        currentPrice={market.reference.currentPrice}
                        onEnterArena={() => scrollToSection("arena-trade")}
                        onViewLeaderboard={() => selectView("leaderboard")}
                        participantCount={snapshot.arena.participantCount}
                        roundMarket={predictRound.market}
                        prizePool={snapshot.arena.prizePool}
                    />
                    <section className="arena-content" id="arena-trade">
                        <div className="trade-card-row">
                            <PredictBinaryCard
                                countdownLabel={predictRound.countdownLabel}
                                roundMarket={predictRound.market}
                                spotTimestampMs={market.reference.updatedAtMs}
                            />
                            <NextRangeRoundCard
                                currentPrice={market.reference.currentPrice}
                                roundMarket={predictRound.market}
                            />
                            <PlpSandboxPanel />
                        </div>
                        <div className="market-ranking-row" id="arena-market-ranking">
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
                </section>
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
                            <strong title={currentPlayer?.predictManagerId ?? undefined}>
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
                        <div className="position-row">
                            <span className={`position-kind ${activePosition.kind}`}>
                                {activePosition.kind}
                            </span>
                            <div>
                                <strong>{activePosition.label}</strong>
                                <small>{activePosition.quantity}</small>
                            </div>
                            <div>
                                <span>Cost</span>
                                <strong>{activePosition.amountLabel}</strong>
                            </div>
                            <div>
                                <span>PnL</span>
                                <strong>{activePosition.pnlLabel}</strong>
                                <small>
                                    {activePosition.resultLabel} · {activePosition.statusLabel}
                                </small>
                            </div>
                        </div>
                    </section>
                    <section className="surface settled-history">
                        <div className="section-title">
                            <div>
                                <span>Settled rounds</span>
                                <h2>Recent results</h2>
                            </div>
                            <strong>{settledHistory.length} records</strong>
                        </div>
                        <div className="settled-history-list">
                            {settledHistory.map((item) => (
                                <article className="settled-history-row" key={item.id}>
                                    <div>
                                        <span>{item.roundType}</span>
                                        <strong>{item.marketLabel}</strong>
                                    </div>
                                    <div>
                                        <span>PnL</span>
                                        <strong>{item.pnlLabel}</strong>
                                    </div>
                                    <div>
                                        <span>Result</span>
                                        <strong>{item.resultLabel}</strong>
                                    </div>
                                    <div>
                                        <span>Status</span>
                                        <strong>{item.statusLabel}</strong>
                                        <small>{item.settledAtLabel}</small>
                                    </div>
                                </article>
                            ))}
                        </div>
                    </section>
                    <HistoryTable events={ownEvents} title="Your history" />
                </section>
            ) : null}

            {view === "leaderboard" ? (
                <section className="page-view">
                    <div className="page-heading">
                        <span>Competition overview</span>
                        <h1>Leaderboard</h1>
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

            {view === "how-it-works" ? (
                <section className="page-view">
                    <div className="page-heading">
                        <span>Rules</span>
                        <h1>How It Works</h1>
                        <p>Binary, Range, and PLP are explained here, away from the main arena.</p>
                    </div>
                    <ReversalSection />
                    <PrimitiveSection />
                    <SystemMap />
                    <LocalModeSection />
                </section>
            ) : null}
        </main>
    );
}

export default function Home() {
    return <HomeContent />;
}
