"use client";

import { WalletProvider } from "@/features/wallet/wallet-provider";

export function Providers({ children }: { children: React.ReactNode }) {
    return <WalletProvider>{children}</WalletProvider>;
}
