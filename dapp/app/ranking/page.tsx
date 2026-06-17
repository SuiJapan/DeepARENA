"use client";

import { DashboardShell } from "@/features/deep-arena/dashboard-shell";
import { RankingView } from "@/features/deep-arena/ranking-view";
import { useDeepArena } from "@/features/deep-arena/use-deep-arena";

export default function RankingPage() {
    const { error } = useDeepArena();

    return (
        <DashboardShell activeView="leaderboard">
            {error ? <div className="error-banner">{error}</div> : null}

            <RankingView />
        </DashboardShell>
    );
}
