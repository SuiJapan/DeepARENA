"use client";

import { ArenaView } from "@/features/deep-arena/arena-view";
import { DashboardShell } from "@/features/deep-arena/dashboard-shell";
import { useDeepArena } from "@/features/deep-arena/use-deep-arena";
import { useMarketStream } from "@/features/market/use-market-stream";
import { usePredictRound } from "@/features/predict-round/use-predict-round";

function HomeContent() {
    const { snapshot, error } = useDeepArena();
    const predictRound = usePredictRound();
    const market = useMarketStream(predictRound.market?.currentOracle?.oracleId ?? null);

    return (
        <DashboardShell activeView="arena">
            {error ? <div className="error-banner">{error}</div> : null}

            <ArenaView market={market} predictRound={predictRound} snapshot={snapshot} />
        </DashboardShell>
    );
}

export default function Home() {
    return <HomeContent />;
}
