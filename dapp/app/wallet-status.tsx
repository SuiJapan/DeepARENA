"use client";

import { useCurrentNetwork, useDAppKit, useWalletConnection } from "@mysten/dapp-kit-react";
import { useState } from "react";
import { ConnectButton } from "./dapp-kit-client-provider";

const TESTNET_NETWORK = "testnet";

function shortAddress(value: string): string {
    return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function formatNetwork(value: string): string {
    return value === TESTNET_NETWORK ? "Testnet" : value;
}

function readErrorMessage(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}

export function WalletStatus() {
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

    return (
        <div className="wallet-status">
            {isConnected || isReconnecting ? (
                <div className="wallet-status-main">
                    <strong title={connection.account.address}>
                        {shortAddress(connection.account.address)}
                    </strong>
                    <small>{formatNetwork(network)}</small>
                    {isWrongNetwork ? (
                        <span className="wallet-state" data-status="wrong-network">
                            Wrong network
                        </span>
                    ) : null}
                </div>
            ) : null}
            <div className="wallet-status-actions">
                {isConnected || isReconnecting ? (
                    <button type="button" className="wallet-disconnect-button" onClick={disconnect}>
                        Disconnect
                    </button>
                ) : (
                    <ConnectButton>Connect Wallet</ConnectButton>
                )}
            </div>
            {disconnectError ? <p className="wallet-warning">{disconnectError}</p> : null}
        </div>
    );
}
