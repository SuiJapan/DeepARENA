"use client";

import { WalletStatus } from "@/features/wallet/wallet-status";
import { deepArenaMockConfig } from "@/lib/deep-arena/config";

export type DashboardView = "arena" | "portfolio" | "ranking";

export function DashboardShell({
    activeView,
    children,
    onViewChange,
}: {
    activeView: DashboardView;
    children: React.ReactNode;
    onViewChange: (view: DashboardView) => void;
}) {
    return (
        <main className="app-shell">
            <header className="app-header">
                <button className="brand" type="button" onClick={() => onViewChange("arena")}>
                    <span className="brand-mark">DA</span>
                    <strong>Deep Arena</strong>
                </button>
                <nav aria-label="Primary navigation">
                    {(["arena", "portfolio", "ranking"] as const).map((item) => (
                        <button
                            type="button"
                            data-active={activeView === item}
                            key={item}
                            onClick={() => onViewChange(item)}
                        >
                            {item}
                        </button>
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
