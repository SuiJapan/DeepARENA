"use client";

import { useState } from "react";
import { MarketChart } from "@/features/market/market-chart";
import type { UseMarketStreamResult } from "@/features/market/use-market-stream";
import { PlpSandboxPanel } from "@/features/plp-sandbox/plp-sandbox-panel";
import { PredictBinaryCard } from "@/features/predict-binary/predict-binary-card";
import { usePredictRange } from "@/features/predict-range/use-predict-range";
import type {
    PredictRoundMarket,
    usePredictRound,
} from "@/features/predict-round/use-predict-round";
import type { DeepArenaSnapshot } from "@/lib/deep-arena/types";
import { calculateMarketRange, formatMarketPrice, marketConfig } from "@/lib/market/config";

type PredictRoundState = ReturnType<typeof usePredictRound>;
type ArenaMode = "binary" | "range" | "plp";

function formatRawPredictPrice(value: string | null): string {
    if (value === null) return "--";
    const raw = BigInt(value);
    const scale = 1_000_000_000n;
    const price = Number(raw / scale) + Number(raw % scale) / Number(scale);
    return formatMarketPrice(price);
}

function formatCloseLabel(ms: number | null): string {
    if (ms === null) return "Close --";
    return `Close ${new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
        hour12: false,
    }).format(new Date(ms))} UTC`;
}

function formatRoundStateLabel(state: PredictRoundMarket["state"] | undefined): string {
    if (state === "BETTING_OPEN") return "LIVE";
    if (state === "LOCKING_ROUND") return "Calculating...";
    if (state === "FINAL_LIVE") return "Round Locked";
    return state ?? "LIVE";
}

function isCompactOddsLabel(value: string | null): boolean {
    if (value === null) return true;
    const normalized = value.trim().toLowerCase();
    return !/\d/.test(normalized);
}

function ModeCard({
    active,
    description,
    mode,
    number,
    onSelect,
    title,
}: {
    active: boolean;
    description: string;
    mode: ArenaMode;
    number: string;
    onSelect: (mode: ArenaMode) => void;
    title: string;
}) {
    return (
        <button
            className={`mode-card mode-${mode}${active ? " active" : ""}`}
            data-mode={mode}
            type="button"
            onClick={() => onSelect(mode)}
        >
            <span className="mode-glyph" aria-hidden="true" />
            <span className="mode-no">{number}</span>
            <h3>{title}</h3>
            <p>{description}</p>
            <span className="badge mode-state">{active ? "Active" : "Inactive"}</span>
        </button>
    );
}

function RangePanel({ roundMarket }: { roundMarket: PredictRoundMarket | null }) {
    const range = usePredictRange(roundMarket);
    const selected = range.direction ?? "RANGE";
    const isRoundLocked = roundMarket?.state === "FINAL_LIVE";
    const isRoundCalculating = roundMarket?.state === "LOCKING_ROUND";
    const actionLabel = range.isBettingOpen
        ? range.direction
            ? `Enter ${range.direction === "RANGE" ? "Range" : "Break"}`
            : "Select Range Side"
        : isRoundCalculating
          ? "Calculating..."
          : isRoundLocked
            ? "Round Locked"
            : "Betting Closed";

    return (
        <div className="panel-view active trade-view" data-panel="range">
            <div className="mode-topper trade-topper">
                <div>
                    <p className="mode-eyebrow">Active mode</p>
                    <h2 className="mode-title">Range Market</h2>
                    <p className="mode-copy">Pick a range or break before the round closes.</p>
                </div>
                <span className="fee-pill">FEE 3%</span>
            </div>

            <div className="range-band-card">
                <span>Range</span>
                <strong>{range.marketLabel}</strong>
            </div>

            <div className="duel-board range-board">
                <button
                    className={`duel-choice choice-button${selected === "RANGE" ? " selected" : ""}`}
                    type="button"
                    disabled={!range.isBettingOpen}
                    onClick={() => range.setDirection(range.direction === "RANGE" ? null : "RANGE")}
                >
                    <span className="duel-name">In Range</span>
                    <span
                        className={`duel-odds${isCompactOddsLabel(range.rangeOdds) ? " duel-odds-status" : ""}`}
                    >
                        {range.rangeOdds}
                    </span>
                </button>
                <div className="duel-vs" aria-hidden="true">
                    VS
                </div>
                <button
                    className={`duel-choice choice-button${selected === "BREAK" ? " selected" : ""}`}
                    type="button"
                    disabled={!range.isBettingOpen}
                    onClick={() => range.setDirection(range.direction === "BREAK" ? null : "BREAK")}
                >
                    <span className="duel-name">Break</span>
                    <span
                        className={`duel-odds${isCompactOddsLabel(range.breakOdds) ? " duel-odds-status" : ""}`}
                    >
                        {range.breakOdds}
                    </span>
                </button>
            </div>

            <div className="stake-card">
                <label htmlFor="range-stake">
                    Your BET{range.activeBetSummary ? `: ${range.activeBetSummary}` : ""}
                </label>
                <div className="stake-input-row">
                    <input
                        id="range-stake"
                        className="amount-input stake-input"
                        min="0"
                        step="1"
                        type="number"
                        value={range.amount}
                        disabled={range.isBusy}
                        onChange={(event) => range.setAmount(event.target.value)}
                    />
                    <span>DUSDC</span>
                </div>
                {range.walletBalanceLabel !== null && (
                    <p className="wallet-balance-line muted-line">
                        Balance: {range.walletBalanceLabel} DUSDC
                    </p>
                )}
                <button
                    className="primary-button cta-full arena-cta"
                    type="button"
                    disabled={!range.canEnter}
                    onClick={() => void range.placeRangeBet()}
                >
                    {actionLabel}
                </button>
            </div>
        </div>
    );
}

export function ArenaView({
    market,
    predictRound,
}: {
    market: UseMarketStreamResult;
    predictRound: PredictRoundState;
    snapshot: DeepArenaSnapshot | null;
}) {
    const [mode, setMode] = useState<ArenaMode>("binary");
    const round = predictRound.market?.round ?? null;
    const currentOracle = predictRound.market?.currentOracle ?? null;
    const currentPrice = market.reference.currentPrice;
    const strikeLabel = formatRawPredictPrice(round?.binaryStrikeRaw ?? null);
    const strike = round?.binaryStrikeRaw
        ? Number(BigInt(round.binaryStrikeRaw)) / 1_000_000_000
        : null;
    const range =
        strike !== null
            ? calculateMarketRange(strike)
            : currentPrice !== null
              ? calculateMarketRange(currentPrice)
              : null;

    return (
        <section id="arena" className="page active" aria-label="Arena page">
            <section className="section-block" id="market">
                <div className="container">
                    <div className="live-round-bar">
                        <div className="live-cell">
                            <div className="cell-label">Market Pair</div>
                            <div className="pair-title">{marketConfig.displaySymbol}</div>
                            <div className="cell-foot">
                                <span className="live-dot" />
                            </div>
                        </div>
                        <div className="live-cell">
                            <div className="cell-label">Settles In</div>
                            <div className="timer-big">
                                {predictRound.countdownLabel ?? "--:--"}
                            </div>
                            <div className="cell-foot">
                                <span>{formatCloseLabel(currentOracle?.expiryMs ?? null)}</span>
                                <span>{formatRoundStateLabel(predictRound.market?.state)}</span>
                            </div>
                        </div>
                        <div className="live-cell">
                            <div className="cell-label">Current Price</div>
                            <div className="price-big">
                                {currentPrice !== null ? formatMarketPrice(currentPrice) : "--"}
                            </div>
                            <div className="cell-foot">
                                <span>Oracle live</span>
                            </div>
                        </div>
                        <div className="live-cell">
                            <div className="cell-label">Reference Strike</div>
                            <div className="price-big" style={{ fontWeight: 700 }}>
                                {strikeLabel}
                            </div>
                            <div className="cell-foot">
                                <span>Strike price</span>
                            </div>
                        </div>
                    </div>

                    <div className="mode-grid">
                        <ModeCard
                            active={mode === "binary"}
                            mode="binary"
                            number="( 01 )"
                            title="Binary Duel"
                            description="Choose whether the live price settles above or below the strike."
                            onSelect={setMode}
                        />
                        <ModeCard
                            active={mode === "range"}
                            mode="range"
                            number="( 02 )"
                            title="Range Market"
                            description="Predict whether price remains inside the active band or breaks out."
                            onSelect={setMode}
                        />
                        <ModeCard
                            active={mode === "plp"}
                            mode="plp"
                            number="( 03 )"
                            title="Predict PLP"
                            description="Manage prediction liquidity with a calmer account-oriented flow."
                            onSelect={setMode}
                        />
                    </div>

                    <div className="market-layout">
                        <article className="editorial-panel chart-panel">
                            <div className="panel-head">
                                <div>
                                    <h2 className="panel-title">Market view</h2>
                                </div>
                                <div className="badge-row">
                                    <span className="badge active">
                                        <span className="live-dot" />
                                        Oracle Live
                                    </span>
                                </div>
                            </div>
                            <MarketChart
                                binaryStrikeRaw={
                                    predictRound.market?.round?.binaryStrikeRaw ?? null
                                }
                                market={market}
                                embedded
                                rangeLabel={
                                    range
                                        ? `Range band · ${formatMarketPrice(range.lower)} — ${formatMarketPrice(range.upper)}`
                                        : null
                                }
                                strikeLabel={
                                    strikeLabel !== "--" ? `Strike · ${strikeLabel}` : null
                                }
                                priceLabel={
                                    currentPrice !== null ? formatMarketPrice(currentPrice) : null
                                }
                            />
                        </article>

                        <aside
                            className="editorial-panel action-panel"
                            aria-label="Active mode action panel"
                        >
                            {mode === "binary" ? (
                                <PredictBinaryCard
                                    countdownLabel={predictRound.countdownLabel}
                                    roundMarket={predictRound.market}
                                    spotTimestampMs={market.reference.updatedAtMs}
                                />
                            ) : null}
                            {mode === "range" ? (
                                <RangePanel roundMarket={predictRound.market} />
                            ) : null}
                            {mode === "plp" ? <PlpSandboxPanel /> : null}
                        </aside>
                    </div>
                </div>
            </section>
        </section>
    );
}
