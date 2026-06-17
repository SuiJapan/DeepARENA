"use client";

import Link from "next/link";
import { WalletStatus } from "@/features/wallet/wallet-status";
import { deepArenaMockConfig } from "@/lib/deep-arena/config";

export type DashboardView = "arena" | "portfolio" | "ranking";

const NAV_ITEMS: ReadonlyArray<{ href: string; label: DashboardView }> = [
    { href: "/", label: "arena" },
    { href: "/portfolio", label: "portfolio" },
    { href: "/ranking", label: "ranking" },
];

export function DashboardShell({
    activeView,
    children,
}: {
    activeView: DashboardView;
    children: React.ReactNode;
}) {
    return (
        <main className="app-shell">
            <header className="app-header">
                <Link className="brand" href="/">
                    <span className="brand-mark">DA</span>
                    <strong>Deep Arena</strong>
                </Link>
                <nav aria-label="Primary navigation">
                    {NAV_ITEMS.map((item) => (
                        <Link
                            data-active={activeView === item.label}
                            href={item.href}
                            key={item.label}
                        >
                            {item.label}
                        </Link>
                    ))}
                </nav>
                <div
                    className="wallet-button-wrap"
                    title={`Predict UI mode: ${deepArenaMockConfig.network}`}
                >
                    <WalletStatus />
                </div>
            </header>

            {children}
        </main>
    );
}
