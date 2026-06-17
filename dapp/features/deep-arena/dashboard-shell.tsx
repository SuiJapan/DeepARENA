"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { WalletStatus } from "@/features/wallet/wallet-status";

export type DashboardView = "arena" | "portfolio" | "leaderboard";

const NAV_ITEMS: ReadonlyArray<{ href: string; id: DashboardView; label: string }> = [
    { href: "/", id: "arena", label: "Arena" },
    { href: "/portfolio", id: "portfolio", label: "Portfolio" },
    { href: "/ranking", id: "leaderboard", label: "Leaderboard" },
];

export function DashboardShell({
    activeView,
    children,
}: {
    activeView: DashboardView;
    children: React.ReactNode;
}) {
    const [theme, setTheme] = useState<"light" | "dark">("light");
    const [menuOpen, setMenuOpen] = useState(false);

    useEffect(() => {
        document.body.dataset.theme = theme;
    }, [theme]);

    const toggleTheme = () => setTheme((current) => (current === "dark" ? "light" : "dark"));

    return (
        <>
            <div className="noise" aria-hidden="true" />
            <div className="app-shell">
                <header className="topbar">
                    <Link className="brand" href="/" aria-label="Deep Arena home">
                        <span className="brand-word">
                            <span>DEEP</span>
                            <strong>ARENA</strong>
                        </span>
                        <span className="brand-under" aria-hidden="true" />
                    </Link>
                    <nav className="nav-tabs" aria-label="Primary navigation">
                        {NAV_ITEMS.map((item) => (
                            <Link
                                className={`nav-tab${activeView === item.id ? " active" : ""}`}
                                href={item.href}
                                key={item.id}
                            >
                                {item.label}
                            </Link>
                        ))}
                    </nav>
                    <div className="header-actions">
                        <button
                            className="icon-button"
                            type="button"
                            aria-label="Toggle dark mode"
                            onClick={toggleTheme}
                        >
                            {theme === "dark" ? "☀" : "◐"}
                        </button>
                        <WalletStatus />
                    </div>
                    <div className="mobile-actions">
                        <WalletStatus mobile />
                        <button
                            className="mobile-icon menu-mobile"
                            type="button"
                            aria-label="Open menu"
                            aria-expanded={menuOpen}
                            onClick={() => setMenuOpen((open) => !open)}
                        >
                            <span />
                            <span />
                            <span />
                        </button>
                    </div>
                    <nav
                        className={`mobile-menu${menuOpen ? " open" : ""}`}
                        aria-label="Mobile menu"
                    >
                        {NAV_ITEMS.map((item) => (
                            <Link href={item.href} key={item.id} onClick={() => setMenuOpen(false)}>
                                {item.label}
                            </Link>
                        ))}
                        <button type="button" onClick={toggleTheme}>
                            Toggle Theme
                        </button>
                    </nav>
                </header>

                <main>{children}</main>

                <footer className="site-footer">
                    <div className="footer-title">
                        Built for
                        <br />
                        SUI Markets
                    </div>
                    <div className="footer-meta">
                        DeepARENA © 2026
                        <br />
                        SUI prediction arena
                    </div>
                    <div className="footer-actions">
                        <Link className="ghost-button" href="/">
                            Back to top
                        </Link>
                        <WalletStatus footer />
                    </div>
                </footer>
            </div>
        </>
    );
}
