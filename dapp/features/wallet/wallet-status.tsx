"use client";

import { useCurrentNetwork, useDAppKit, useWalletConnection } from "@mysten/dapp-kit-react";
import { useState } from "react";
import { ConnectButton } from "@/features/wallet/wallet-provider";

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
            <div className="wallet-status-main">
                {isConnected || isReconnecting ? (
                    <>
                        <span
                            className="wallet-state"
                            data-status={isWrongNetwork ? "wrong-network" : "connected"}
                        >
                            {isWrongNetwork ? "Wrong network" : "Connected"}
                        </span>
                        <strong>{shortAddress(connection.account.address)}</strong>
                        <small>Network: {formatNetwork(network)}</small>
                    </>
                ) : (
                    <>
                        <span className="wallet-state" data-status={connection.status}>
                            Wallet not connected
                        </span>
                        <ConnectButton>Connect Wallet</ConnectButton>
                    </>
                )}
            </div>
            {isConnected || isReconnecting ? (
                <button type="button" className="wallet-disconnect-button" onClick={disconnect}>
                    Disconnect
                </button>
            ) : null}
            {isWrongNetwork ? (
                <p className="wallet-warning">Please switch your wallet to Sui Testnet</p>
            ) : null}
            {disconnectError ? <p className="wallet-warning">{disconnectError}</p> : null}
        </div>
    );
}
