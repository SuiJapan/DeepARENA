"use client";

import { useState } from "react";
import { ArenaView } from "@/features/deep-arena/arena-view";
import { DashboardShell, type DashboardView } from "@/features/deep-arena/dashboard-shell";
import { RankingView } from "@/features/deep-arena/ranking-view";
import { useDeepArena } from "@/features/deep-arena/use-deep-arena";
import { useMarketStream } from "@/features/market/use-market-stream";
import { PortfolioView } from "@/features/predict-binary/portfolio-view";
import { usePredictRound } from "@/features/predict-round/use-predict-round";

function HomeContent() {
    const [view, setView] = useState<DashboardView>("arena");
    const { snapshot, error } = useDeepArena();
    const predictRound = usePredictRound();
    const market = useMarketStream(predictRound.market?.currentOracle?.oracleId ?? null);

    return (
        <DashboardShell activeView={view} onViewChange={setView}>
            {error ? <div className="error-banner">{error}</div> : null}

            {view === "arena" ? (
                <ArenaView market={market} predictRound={predictRound} snapshot={snapshot} />
            ) : null}

            {view === "portfolio" ? <PortfolioView roundMarket={predictRound.market} /> : null}

            {view === "ranking" ? <RankingView /> : null}
        </DashboardShell>
    );
}

export default function Home() {
    return <HomeContent />;
}
