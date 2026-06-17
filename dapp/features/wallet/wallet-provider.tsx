"use client";

import { DAppKitProvider } from "@mysten/dapp-kit-react";
import type { ConnectButtonProps } from "@mysten/dapp-kit-react/ui";
import dynamic from "next/dynamic";
import { dAppKit } from "@/features/wallet/dapp-kit";

const DAppKitConnectButton = dynamic(
    () => import("@mysten/dapp-kit-react/ui").then((module) => module.ConnectButton),
    { ssr: false },
);

export function WalletProvider({ children }: { children: React.ReactNode }) {
    return <DAppKitProvider dAppKit={dAppKit}>{children}</DAppKitProvider>;
}

export function ConnectButton(props: ConnectButtonProps) {
    return <DAppKitConnectButton {...props} />;
}
