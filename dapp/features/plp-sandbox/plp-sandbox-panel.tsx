"use client";

import { useState } from "react";
import { usePlpSandbox } from "./use-plp-sandbox";

type PlpSandboxMode = "supply" | "withdraw";

export function PlpSandboxPanel() {
    const plp = usePlpSandbox();
    const [mode, setMode] = useState<PlpSandboxMode>("supply");
    const [supplyAmount, setSupplyAmount] = useState("");
    const [withdrawAmount, setWithdrawAmount] = useState("");
    const isBusy = plp.status === "loading";
    const isActionDisabled = !plp.canTransact;
    const isSupplyMode = mode === "supply";
    const amount = isSupplyMode ? supplyAmount : withdrawAmount;
    const setAmount = isSupplyMode ? setSupplyAmount : setWithdrawAmount;
    const maxInput = isSupplyMode ? plp.dusdcMaxInput : plp.plpMaxInput;
    const unit = isSupplyMode ? "DUSDC" : "PLP";

    const statusMessage = (() => {
        if (!plp.address) return "Wallet not connected";
        if (!plp.isTestnet) return "Please switch your wallet to Sui Testnet";
        if (!plp.isConfigured) return "PLP sandbox package is not configured";
        if (plp.isRefreshing) return "Refreshing balances...";
        return "";
    })();

    return (
        <div className="panel-view active trade-view" data-panel="plp">
            <div className="mode-topper trade-topper">
                <div>
                    <p className="mode-eyebrow">Active mode</p>
                    <h2 className="mode-title">Predict PLP</h2>
                    <p className="mode-copy">Supply your prediction. Earn from accuracy.</p>
                </div>
            </div>

            <div className="trade-metric-list plp-metrics">
                <div className="info-row">
                    <span>My DUSDC Balance</span>
                    <strong>{plp.dusdcBalanceLabel}</strong>
                </div>
                <div className="info-row">
                    <span>My PLP Balance</span>
                    <strong>{plp.plpBalanceLabel}</strong>
                </div>
            </div>

            <div className="plp-switch choice-grid" role="tablist" aria-label="PLP action">
                <button
                    className={`choice-button${isSupplyMode ? " selected" : ""}`}
                    type="button"
                    onClick={() => setMode("supply")}
                >
                    <strong>Supply</strong>
                </button>
                <button
                    className={`choice-button${!isSupplyMode ? " selected" : ""}`}
                    type="button"
                    onClick={() => setMode("withdraw")}
                >
                    <strong>Withdraw</strong>
                </button>
            </div>

            <div className="stake-card">
                <label htmlFor="plp-stake">Amount</label>
                <div className="stake-input-row">
                    <span>{unit}</span>
                    <input
                        id="plp-stake"
                        className="amount-input stake-input"
                        inputMode="decimal"
                        placeholder="0.000000"
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                    />
                    <button
                        className="tiny-button max-button"
                        type="button"
                        disabled={isBusy}
                        onClick={() => setAmount(maxInput)}
                    >
                        Max
                    </button>
                </div>
                <button
                    className="primary-button cta-full arena-cta"
                    type="button"
                    disabled={isActionDisabled}
                    onClick={() => void (isSupplyMode ? plp.supply(amount) : plp.withdraw(amount))}
                >
                    {isBusy ? "Processing" : mode}
                </button>
                <p className="payout-line muted-line" data-status={plp.status} aria-live="polite">
                    {plp.balanceError ?? plp.result?.message ?? statusMessage}
                    {plp.result?.explorerUrl ? (
                        <>
                            {" "}
                            <a href={plp.result.explorerUrl} target="_blank" rel="noreferrer">
                                View transaction
                            </a>
                        </>
                    ) : null}
                </p>
            </div>
        </div>
    );
}
