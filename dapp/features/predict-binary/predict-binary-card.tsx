"use client";

import { useState } from "react";
import type { PredictRoundMarket } from "@/features/predict-round/use-predict-round";
import { type BinaryDirection, usePredictBinary } from "./use-predict-binary";

function isCompactOddsLabel(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return !/\d/.test(normalized);
}

export function PredictBinaryCard({
    roundMarket,
    spotTimestampMs,
}: {
    countdownLabel: string | null;
    roundMarket: PredictRoundMarket | null;
    spotTimestampMs: number | null;
}) {
    const binary = usePredictBinary(roundMarket, spotTimestampMs);
    const [direction, setDirection] = useState<BinaryDirection | null>("UP");
    const canEnter =
        direction === "UP" ? binary.canBetUp : direction === "DOWN" ? binary.canBetDown : false;
    const isBettingOpen = roundMarket?.state === "BETTING_OPEN";
    const isRoundLocked = roundMarket?.state === "FINAL_LIVE";
    const isRoundCalculating = roundMarket?.state === "LOCKING_ROUND";
    const choiceDisabled = binary.isBusy || !isBettingOpen;
    const actionLabel = isBettingOpen
        ? direction
            ? `Enter ${direction}`
            : "Select Direction"
        : isRoundCalculating
          ? "Calculating..."
          : isRoundLocked
            ? "Round Locked"
            : "Betting Closed";

    return (
        <div className="panel-view active trade-view" data-panel="binary">
            <div className="mode-topper trade-topper">
                <div>
                    <p className="mode-eyebrow">Active mode</p>
                    <h2 className="mode-title">Binary Duel</h2>
                    <p className="mode-copy">Above or below the strike when the bell tolls?</p>
                </div>
                <span className="fee-pill">{binary.feeBpsLabel}</span>
            </div>

            <div className="duel-board binary-board">
                <button
                    className={`duel-choice choice-button up-choice${direction === "UP" ? " selected" : ""}`}
                    type="button"
                    disabled={choiceDisabled}
                    aria-pressed={direction === "UP"}
                    onClick={() => setDirection(direction === "UP" ? null : "UP")}
                >
                    <span className="duel-sigil blade-sigil blade-sigil-up" aria-hidden="true" />
                    <span className="duel-name">UP</span>
                    <span
                        className={`duel-odds${isCompactOddsLabel(binary.upOdds) ? " duel-odds-status" : ""}`}
                    >
                        {binary.upOdds}
                    </span>
                </button>
                <div className="duel-vs" aria-hidden="true">
                    VS
                </div>
                <button
                    className={`duel-choice choice-button down-choice${direction === "DOWN" ? " selected" : ""}`}
                    type="button"
                    disabled={choiceDisabled}
                    aria-pressed={direction === "DOWN"}
                    onClick={() => setDirection(direction === "DOWN" ? null : "DOWN")}
                >
                    <span className="duel-sigil blade-sigil blade-sigil-down" aria-hidden="true" />
                    <span className="duel-name">DOWN</span>
                    <span
                        className={`duel-odds${isCompactOddsLabel(binary.downOdds) ? " duel-odds-status" : ""}`}
                    >
                        {binary.downOdds}
                    </span>
                </button>
            </div>

            <div className="stake-card">
                <label htmlFor="binary-stake">
                    Your BET{binary.activeBetSummary ? `: ${binary.activeBetSummary}` : ""}
                </label>
                <div className="stake-input-row">
                    <input
                        id="binary-stake"
                        className="amount-input stake-input"
                        min="0"
                        step="0.000001"
                        type="number"
                        value={binary.amount}
                        disabled={binary.isBusy}
                        onChange={(event) => binary.setAmount(event.target.value)}
                    />
                    <span>DUSDC</span>
                </div>
                {binary.walletBalanceLabel !== null && (
                    <p className="wallet-balance-line muted-line">
                        Balance: {binary.walletBalanceLabel} DUSDC
                    </p>
                )}

                <button
                    className="primary-button cta-full arena-cta"
                    type="button"
                    disabled={!canEnter}
                    onClick={() => direction && void binary.placeBet(direction)}
                >
                    {actionLabel}
                </button>

            </div>
        </div>
    );
}
