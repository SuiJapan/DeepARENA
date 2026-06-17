"use client";

import { useCurrentNetwork, useDAppKit, useWalletConnection } from "@mysten/dapp-kit-react";
import { useState } from "react";
import { ConnectButton } from "@/features/wallet/wallet-provider";

const TESTNET_NETWORK = "testnet";

function shortAddress(value: string): string {
    return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function readErrorMessage(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}

export function WalletStatus({
    footer = false,
    mobile = false,
}: {
    footer?: boolean;
    mobile?: boolean;
}) {
    const dAppKit = useDAppKit();
    const connection = useWalletConnection();
    const network = useCurrentNetwork();
    const [disconnectError, setDisconnectError] = useState<string | null>(null);

    const isConnected = connection.status === "connected";
    const isReconnecting = connection.status === "reconnecting";
    const isWrongNetwork = network !== TESTNET_NETWORK;

    async function disconnect() {
        setDisconnectError(null);
        try {
            await dAppKit.disconnectWallet();
        } catch (caught) {
            const message = readErrorMessage(caught);
            console.error("Wallet disconnect failed:", caught);
            setDisconnectError(message);
        }
    }

    if (mobile) {
        return (
            <ConnectButton className="mobile-icon wallet-mobile" aria-label="Connect wallet">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4.5 7.5h13.8c.9 0 1.7.8 1.7 1.7v7.1c0 .9-.8 1.7-1.7 1.7H4.5c-1 0-1.8-.8-1.8-1.8V7.9c0-1 .8-1.8 1.8-1.8h13.1" />
                    <path d="M16.4 12h3.6v3h-3.6c-.8 0-1.4-.7-1.4-1.5s.6-1.5 1.4-1.5Z" />
                </svg>
            </ConnectButton>
        );
    }

    if (!isConnected && !isReconnecting) {
        return (
            <ConnectButton className={footer ? "primary-button" : "wallet-button"}>
                Connect Wallet
            </ConnectButton>
        );
    }

    return (
        <div className="wallet-status">
            <button
                type="button"
                className={footer ? "primary-button" : "wallet-button"}
                title={
                    disconnectError ??
                    (isWrongNetwork
                        ? "Please switch your wallet to Sui Testnet"
                        : "Disconnect wallet")
                }
                onClick={disconnect}
            >
                {isWrongNetwork ? "Wrong Network" : shortAddress(connection.account.address)}
            </button>
        </div>
    );
}
