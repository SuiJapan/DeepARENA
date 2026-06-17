"use client";

import {
    useCurrentAccount,
    useCurrentClient,
    useCurrentNetwork,
    useDAppKit,
} from "@mysten/dapp-kit-react";
import { useCallback, useEffect, useState } from "react";
import { BALANCE_REFRESH_EVENT } from "@/lib/balance-refresh";
import {
    formatTokenAmount,
    formatTokenInputAmount,
    parseTokenAmount,
} from "@/lib/plp-sandbox/amounts";
import {
    hasPlpSandboxPackageId,
    PLP_SANDBOX_CONFIG,
    plpSandboxExplorerUrl,
} from "@/lib/plp-sandbox/config";
import { createPlpSandboxTransaction } from "@/lib/plp-sandbox/transactions";
import { isWalletUserRejection, readWalletCancellationDebug } from "@/lib/wallet-errors";

type PlpSandboxStatus = "idle" | "loading" | "success" | "error";

interface PlpSandboxBalances {
    dusdc: bigint;
    plp: bigint;
}

interface PlpSandboxResult {
    message: string;
    digest?: string;
    explorerUrl?: string;
}

function readErrorMessage(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function readBalanceValue(value: unknown): bigint {
    if (typeof value === "bigint") {
        return value;
    }
    if (typeof value === "number" && Number.isSafeInteger(value)) {
        return BigInt(value);
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
        return BigInt(value);
    }
    throw new Error("Invalid balance response");
}

function readTransactionDigest(result: unknown): string {
    if (!isRecord(result)) {
        throw new Error("Invalid transaction response");
    }
    const failed = result.FailedTransaction;
    if (isRecord(failed)) {
        const status = failed.status;
        throw new Error(isRecord(status) ? readErrorMessage(status.error) : "Transaction failed");
    }
    const transaction = result.Transaction;
    if (!isRecord(transaction) || typeof transaction.digest !== "string") {
        throw new Error("Transaction digest is missing");
    }
    return transaction.digest;
}

function classifyTransactionError(caught: unknown, fallback: string): string {
    if (isWalletUserRejection(caught)) {
        return "Transaction cancelled";
    }
    return fallback;
}

export function usePlpSandbox() {
    const account = useCurrentAccount();
    const network = useCurrentNetwork();
    const client = useCurrentClient();
    const dAppKit = useDAppKit();
    const [balances, setBalances] = useState<PlpSandboxBalances>({ dusdc: 0n, plp: 0n });
    const [status, setStatus] = useState<PlpSandboxStatus>("idle");
    const [result, setResult] = useState<PlpSandboxResult | null>(null);
    const [balanceError, setBalanceError] = useState<string | null>(null);
    const [isRefreshing, setIsRefreshing] = useState(false);

    const address = account?.address ?? null;
    const isTestnet = network === PLP_SANDBOX_CONFIG.network;
    const isConfigured = hasPlpSandboxPackageId();

    const refreshBalances = useCallback(async () => {
        if (!address) {
            setBalances({ dusdc: 0n, plp: 0n });
            return;
        }

        setIsRefreshing(true);
        setBalanceError(null);
        try {
            const [dusdcBalance, plpBalance] = await Promise.all([
                client.core.getBalance({
                    owner: address,
                    coinType: PLP_SANDBOX_CONFIG.dusdcCoinType,
                }),
                client.core.getBalance({
                    owner: address,
                    coinType: PLP_SANDBOX_CONFIG.plpCoinType,
                }),
            ]);
            setBalances({
                dusdc: readBalanceValue(dusdcBalance.balance.balance),
                plp: readBalanceValue(plpBalance.balance.balance),
            });
        } catch (caught) {
            console.error("PLP sandbox balance refresh failed:", caught);
            setBalanceError("Balance refresh failed");
        } finally {
            setIsRefreshing(false);
        }
    }, [address, client]);

    useEffect(() => {
        void refreshBalances();
    }, [refreshBalances]);

    useEffect(() => {
        const refreshAfterExternalTransaction = () => {
            void refreshBalances();
            window.setTimeout(() => void refreshBalances(), 1_500);
        };
        window.addEventListener(BALANCE_REFRESH_EVENT, refreshAfterExternalTransaction);
        return () =>
            window.removeEventListener(BALANCE_REFRESH_EVENT, refreshAfterExternalTransaction);
    }, [refreshBalances]);

    const runLiquidityAction = useCallback(
        async (action: "supply" | "withdraw", input: string) => {
            setResult(null);

            if (!address) {
                setStatus("error");
                setResult({ message: "Wallet is not connected" });
                return;
            }
            if (!isTestnet) {
                setStatus("error");
                setResult({ message: "Please switch your wallet to Sui Testnet" });
                return;
            }
            if (!isConfigured) {
                setStatus("error");
                setResult({ message: "PLP sandbox package is not configured" });
                return;
            }

            let amount: bigint;
            try {
                amount = parseTokenAmount(input, PLP_SANDBOX_CONFIG.dusdcDecimals).atomic;
            } catch (caught) {
                setStatus("error");
                setResult({ message: readErrorMessage(caught) });
                return;
            }

            const balance = action === "supply" ? balances.dusdc : balances.plp;
            if (amount > balance) {
                setStatus("error");
                setResult({
                    message:
                        action === "supply"
                            ? "Insufficient DUSDC balance"
                            : "Insufficient PLP balance",
                });
                return;
            }

            setStatus("loading");
            try {
                const transaction = createPlpSandboxTransaction({
                    action,
                    amount,
                    sender: address,
                });
                const executed = await dAppKit.signAndExecuteTransaction({
                    transaction,
                });
                const digest = readTransactionDigest(executed);
                await client.core.waitForTransaction({
                    digest,
                    timeout: 60_000,
                    include: { effects: true },
                });

                setStatus("success");
                setResult({
                    message: action === "supply" ? "DUSDC supplied" : "PLP withdrawn",
                    digest,
                    explorerUrl: plpSandboxExplorerUrl(digest),
                });

                try {
                    await refreshBalances();
                } catch (caught) {
                    console.error("PLP sandbox post-transaction balance refresh failed:", caught);
                    setBalanceError("Balance refresh failed");
                }
            } catch (caught) {
                if (isWalletUserRejection(caught)) {
                    console.info(
                        "PLP sandbox transaction cancelled",
                        readWalletCancellationDebug(caught),
                    );
                    setStatus("idle");
                    setResult({ message: "Transaction cancelled" });
                    return;
                }
                console.error("PLP sandbox transaction failed:", caught);
                setStatus("error");
                setResult({
                    message: classifyTransactionError(
                        caught,
                        action === "supply"
                            ? "Liquidity could not be supplied"
                            : "Liquidity could not be withdrawn",
                    ),
                });
            }
        },
        [
            address,
            balances.dusdc,
            balances.plp,
            client,
            dAppKit,
            isConfigured,
            isTestnet,
            refreshBalances,
        ],
    );

    return {
        address,
        network,
        isTestnet,
        isConfigured,
        canTransact: Boolean(address) && isTestnet && isConfigured && status !== "loading",
        balances,
        dusdcBalanceLabel: `${formatTokenAmount(
            balances.dusdc,
            PLP_SANDBOX_CONFIG.dusdcDecimals,
        )} DUSDC`,
        plpBalanceLabel: `${formatTokenAmount(balances.plp, PLP_SANDBOX_CONFIG.plpDecimals)} PLP`,
        dusdcMaxInput: formatTokenInputAmount(balances.dusdc, PLP_SANDBOX_CONFIG.dusdcDecimals),
        plpMaxInput: formatTokenInputAmount(balances.plp, PLP_SANDBOX_CONFIG.plpDecimals),
        isRefreshing,
        balanceError,
        status,
        result,
        refreshBalances,
        supply: (input: string) => runLiquidityAction("supply", input),
        withdraw: (input: string) => runLiquidityAction("withdraw", input),
    };
}
