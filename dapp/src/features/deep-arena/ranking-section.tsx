"use client";

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PlayerSummary, TokenAmount } from "@/src/lib/deep-arena/types";

const RANKING_PAGE_SIZE = 20;

interface LeaderboardState {
    players: PlayerSummary[];
    fetchedAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTokenAmount(value: unknown): TokenAmount | null {
    if (!isRecord(value)) {
        return null;
    }
    const { atomic, decimals, symbol } = value;
    if (
        typeof atomic !== "string" ||
        !/^\d+$/.test(atomic) ||
        typeof decimals !== "number" ||
        typeof symbol !== "string"
    ) {
        return null;
    }
    return { atomic, decimals, symbol };
}

function readPlayerSummary(value: unknown): PlayerSummary | null {
    if (!isRecord(value)) {
        return null;
    }
    const score = readTokenAmount(value.score);
    const deposited = readTokenAmount(value.deposited);
    if (
        typeof value.address !== "string" ||
        typeof value.rank !== "number" ||
        typeof value.predictManagerId !== "string" ||
        score === null ||
        deposited === null
    ) {
        return null;
    }
    return {
        address: value.address,
        displayName: typeof value.displayName === "string" ? value.displayName : value.address,
        rank: value.rank,
        score,
        deposited,
        predictManagerId: value.predictManagerId,
        isCurrentPlayer: false,
    };
}

function formatAmount(amount: TokenAmount, maximumFractionDigits = 6): string {
    const value = Number(amount.atomic) / 10 ** amount.decimals;
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value)} ${amount.symbol}`;
}

function shortId(value: string): string {
    return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function formatUpdatedAt(ms: number): string {
    return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: "Asia/Tokyo",
        hour12: false,
    }).format(new Date(ms));
}

export function RankingSection() {
    const account = useCurrentAccount();
    const address = account?.address?.toLowerCase() ?? null;
    const [state, setState] = useState<LeaderboardState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [page, setPage] = useState(1);

    const refresh = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const response = await fetch("/api/arena/leaderboard", { cache: "no-store" });
            if (!response.ok) {
                throw new Error(`Leaderboard fetch failed: ${response.status}`);
            }
            const payload = (await response.json()) as unknown;
            if (!isRecord(payload) || !Array.isArray(payload.players)) {
                throw new Error("Invalid leaderboard response");
            }
            if (typeof payload.error === "string" && payload.error.length > 0) {
                throw new Error(payload.error);
            }
            const players = payload.players
                .map(readPlayerSummary)
                .filter((player): player is PlayerSummary => player !== null);
            setState({
                players,
                fetchedAtMs:
                    typeof payload.fetchedAtMs === "number" ? payload.fetchedAtMs : Date.now(),
            });
            setPage(1);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const players = useMemo(() => state?.players ?? [], [state]);
    const currentPlayer = useMemo(
        () =>
            address === null
                ? null
                : (players.find((player) => player.address.toLowerCase() === address) ?? null),
        [address, players],
    );
    const pageCount = Math.max(1, Math.ceil(players.length / RANKING_PAGE_SIZE));
    const safePage = Math.min(page, pageCount);
    const pagedPlayers = players.slice(
        (safePage - 1) * RANKING_PAGE_SIZE,
        safePage * RANKING_PAGE_SIZE,
    );

    return (
        <section className="surface ranking-board">
            <div className="section-title">
                <div>
                    <span>Arena season standings</span>
                    <h2>Leaderboard</h2>
                </div>
                <div className="ranking-title-side">
                    <strong>
                        {players.length} players · Page {safePage} / {pageCount}
                    </strong>
                    <button type="button" className="text-action" onClick={() => void refresh()}>
                        Refresh
                    </button>
                </div>
            </div>
            {error ? (
                <div className="empty-state">Leaderboard fetch failed: {error}</div>
            ) : isLoading && !state ? (
                <div className="empty-state">Loading leaderboard...</div>
            ) : players.length === 0 ? (
                <div className="empty-state">No players have joined the arena yet.</div>
            ) : (
                <>
                    <div className="ranking-list">
                        {pagedPlayers.map((player) => {
                            const isCurrent =
                                address !== null && player.address.toLowerCase() === address;
                            return (
                                <article key={player.address} data-current={isCurrent}>
                                    <div>
                                        <span>Rank</span>
                                        <strong
                                            className={`ranking-rank${player.rank <= 3 ? " is-top" : ""}`}
                                        >
                                            {player.rank}
                                        </strong>
                                    </div>
                                    <div>
                                        <span>Player</span>
                                        <strong title={player.address}>
                                            {shortId(player.address)}
                                            {isCurrent ? (
                                                <em className="ranking-you">YOU</em>
                                            ) : null}
                                        </strong>
                                    </div>
                                    <div>
                                        <span>Score (PnL)</span>
                                        <strong>{formatAmount(player.score)}</strong>
                                    </div>
                                    <div>
                                        <span>Total Bet</span>
                                        <strong>{formatAmount(player.deposited)}</strong>
                                    </div>
                                    <div>
                                        <span>Predict Manager</span>
                                        <small title={player.predictManagerId}>
                                            {shortId(player.predictManagerId)}
                                        </small>
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                    {pageCount > 1 ? (
                        <div className="binary-history-pagination">
                            <button
                                type="button"
                                className="text-action"
                                disabled={safePage <= 1}
                                onClick={() => setPage((current) => Math.max(1, current - 1))}
                            >
                                Previous
                            </button>
                            <span>
                                {Math.min((safePage - 1) * RANKING_PAGE_SIZE + 1, players.length)}-
                                {Math.min(safePage * RANKING_PAGE_SIZE, players.length)}
                            </span>
                            <button
                                type="button"
                                className="text-action"
                                disabled={safePage >= pageCount}
                                onClick={() =>
                                    setPage((current) => Math.min(pageCount, current + 1))
                                }
                            >
                                Next
                            </button>
                        </div>
                    ) : null}
                </>
            )}
            <p className="binary-portfolio-note">
                Score is net PnL recorded onchain for Deep Arena bets.
                {state ? ` Updated ${formatUpdatedAt(state.fetchedAtMs)} JST.` : ""}
                {currentPlayer ? ` Your rank: ${currentPlayer.rank}.` : ""}
            </p>
        </section>
    );
}
