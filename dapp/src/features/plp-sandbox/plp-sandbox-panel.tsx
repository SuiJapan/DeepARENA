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
        if (!plp.address) {
            return "Wallet not connected";
        }
        if (!plp.isTestnet) {
            return "Please switch your wallet to Sui Testnet";
        }
        if (!plp.isConfigured) {
            return "PLP sandbox package is not configured";
        }
        if (plp.isRefreshing) {
            return "Refreshing balances...";
        }
        return "Supply DUSDC or withdraw PLP on Sui Testnet.";
    })();

    return (
        <section className="trade-card plp-sandbox-card">
            <div className="card-title">
                <div>
                    <span>Liquidity</span>
                    <h2>Predict PLP</h2>
                </div>
            </div>

            <dl className="plp-sandbox-facts">
                <div>
                    <dt>DUSDC balance</dt>
                    <dd>{plp.dusdcBalanceLabel}</dd>
                </div>
                <div>
                    <dt>PLP balance</dt>
                    <dd>{plp.plpBalanceLabel}</dd>
                </div>
            </dl>

            <div className="plp-sandbox-actions">
                <div className="plp-sandbox-tabs" role="tablist" aria-label="PLP action">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={isSupplyMode}
                        data-active={isSupplyMode}
                        onClick={() => setMode("supply")}
                    >
                        supply
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={!isSupplyMode}
                        data-active={!isSupplyMode}
                        onClick={() => setMode("withdraw")}
                    >
                        withdraw
                    </button>
                </div>

                <label className="plp-amount-field">
                    <span>Amount</span>
                    <div>
                        <input
                            inputMode="decimal"
                            placeholder="0.000000"
                            value={amount}
                            onChange={(event) => setAmount(event.target.value)}
                        />
                        <strong>{unit}</strong>
                        <button
                            type="button"
                            className="amount-max-button"
                            disabled={isBusy}
                            onClick={() => setAmount(maxInput)}
                        >
                            MAX
                        </button>
                    </div>
                </label>
                <button
                    type="button"
                    className="binary-enter-button"
                    disabled={isActionDisabled}
                    onClick={() => void (isSupplyMode ? plp.supply(amount) : plp.withdraw(amount))}
                >
                    {isBusy ? "processing" : mode}
                </button>
            </div>

            <div className="plp-sandbox-status" data-status={plp.status} aria-live="polite">
                {plp.balanceError ? <p>{plp.balanceError}</p> : null}
                {plp.result ? <p>{plp.result.message}</p> : null}
                {plp.result?.digest ? (
                    <p>
                        Transaction digest: <code>{plp.result.digest}</code>
                    </p>
                ) : null}
                {plp.result?.explorerUrl ? (
                    <a href={plp.result.explorerUrl} target="_blank" rel="noreferrer">
                        View in Sui Explorer
                    </a>
                ) : null}
                {!plp.result && !plp.balanceError ? <p>{statusMessage}</p> : null}
            </div>
        </section>
    );
}
