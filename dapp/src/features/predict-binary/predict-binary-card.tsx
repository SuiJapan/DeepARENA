"use client";

import { useState } from "react";
import type { PredictRoundMarket } from "@/src/features/predict-round/use-predict-round";
import { type BinaryDirection, usePredictBinary } from "./use-predict-binary";

export function PredictBinaryCard({
    countdownLabel,
    roundMarket,
    spotTimestampMs,
}: {
    countdownLabel: string | null;
    roundMarket: PredictRoundMarket | null;
    spotTimestampMs: number | null;
}) {
    const binary = usePredictBinary(roundMarket, spotTimestampMs);
    const [direction, setDirection] = useState<BinaryDirection | null>(null);
    const canEnter =
        direction === "UP" ? binary.canBetUp : direction === "DOWN" ? binary.canBetDown : false;
    const isBettingOpen = roundMarket?.state === "BETTING_OPEN";
    const hasActiveRound = Boolean(roundMarket?.currentOracle && roundMarket.round);
    const hasSidePosition = Boolean(binary.sidePositionLabels.UP || binary.sidePositionLabels.DOWN);
    const countdownTitle = isBettingOpen ? "BETTING CLOSES IN" : "SETTLES IN";
    const inactiveTitle =
        roundMarket?.state === "LOCKING_ROUND"
            ? "LOCKING ROUND"
            : roundMarket?.state === "ROUND_LOCK_ERROR"
              ? "ROUND UNAVAILABLE"
              : roundMarket?.state === "ROUND_DATA_ERROR"
                ? "ROUND DATA ERROR"
                : "NO ACTIVE ROUND";
    const inputDisabled = binary.isBusy || !isBettingOpen;

    return (
        <section className="trade-card binary next-binary-card">
            <div className="card-title">
                <div>
                    <span>BINARY</span>
                    <h2>BTC</h2>
                </div>
                <div className="binary-title-countdown" aria-live="polite">
                    <span>{hasActiveRound ? countdownTitle : inactiveTitle}</span>
                    <strong>{hasActiveRound ? (countdownLabel ?? "00:00:00") : "--:--:--"}</strong>
                </div>
            </div>

            <fieldset className="direction-picker">
                <legend>Choose prediction direction</legend>
                <button
                    type="button"
                    className="direction-up"
                    data-active={direction === "UP"}
                    aria-pressed={direction === "UP"}
                    disabled={inputDisabled}
                    onClick={() => setDirection(direction === "UP" ? null : "UP")}
                >
                    <span>UP</span>
                    <strong>{binary.upOdds}</strong>
                </button>
                <button
                    type="button"
                    className="direction-down"
                    data-active={direction === "DOWN"}
                    aria-pressed={direction === "DOWN"}
                    disabled={inputDisabled}
                    onClick={() => setDirection(direction === "DOWN" ? null : "DOWN")}
                >
                    <span>DOWN</span>
                    <strong>{binary.downOdds}</strong>
                </button>
                {hasSidePosition ? (
                    <>
                        {binary.sidePositionLabels.UP ? (
                            <div className="binary-position-chip position-up">
                                <span>YOUR BET</span>
                                <strong>{binary.sidePositionLabels.UP.bet}</strong>
                                {binary.sidePositionLabels.UP.entryOdds ? (
                                    <em>Entry {binary.sidePositionLabels.UP.entryOdds}</em>
                                ) : null}
                            </div>
                        ) : (
                            <div className="binary-position-chip position-empty" aria-hidden />
                        )}
                        {binary.sidePositionLabels.DOWN ? (
                            <div className="binary-position-chip position-down">
                                <span>YOUR BET</span>
                                <strong>{binary.sidePositionLabels.DOWN.bet}</strong>
                                {binary.sidePositionLabels.DOWN.entryOdds ? (
                                    <em>Entry {binary.sidePositionLabels.DOWN.entryOdds}</em>
                                ) : null}
                            </div>
                        ) : (
                            <div className="binary-position-chip position-empty" aria-hidden />
                        )}
                    </>
                ) : null}
            </fieldset>

            <label className="binary-amount">
                <span>
                    BET AMOUNT{" "}
                    <small style={{ opacity: 0.6, fontWeight: "normal" }}>
                        {binary.feeBpsLabel}
                    </small>
                </span>
                <div>
                    <input
                        type="number"
                        min="0"
                        step="0.000001"
                        value={binary.amount}
                        disabled={inputDisabled}
                        onChange={(event) => binary.setAmount(event.target.value)}
                    />
                    <strong>DUSDC</strong>
                </div>
            </label>

            <button
                type="button"
                className="binary-enter-button"
                disabled={!canEnter}
                onClick={() => direction && void binary.placeBet(direction)}
            >
                {isBettingOpen ? (direction ? `ENTER ${direction}` : "select") : "BETTING CLOSED"}
            </button>

            <div className="binary-entry-status" aria-live="polite">
                {binary.lastRedeem ? (
                    <>
                        <span>{binary.lastRedeem.payout > 0n ? "YOU WON" : "ROUND LOST"}</span>
                        {binary.settledEntryOddsLabel ? (
                            <span>ENTRY ODDS {binary.settledEntryOddsLabel}</span>
                        ) : null}
                        {binary.payoutLabel ? <span>PAYOUT {binary.payoutLabel}</span> : null}
                    </>
                ) : binary.position && binary.position.cost > 0n ? (
                    <>
                        <span>YOUR PICK {binary.position.direction}</span>
                        {binary.entryCostLabel ? <span>BET {binary.entryCostLabel}</span> : null}
                        {binary.entryOddsLabel ? (
                            <span>ENTRY ODDS {binary.entryOddsLabel}</span>
                        ) : null}
                    </>
                ) : null}
                {binary.txStatus === "FAILED" ? <span>{binary.message}</span> : null}
                {binary.txStatus !== "FAILED" &&
                direction &&
                !canEnter &&
                binary.oddsUnavailableLabel ? (
                    <span>{binary.oddsUnavailableLabel}</span>
                ) : null}
                {binary.explorerUrl ? (
                    <a href={binary.explorerUrl} target="_blank" rel="noreferrer">
                        View transaction
                    </a>
                ) : null}
            </div>
        </section>
    );
}
