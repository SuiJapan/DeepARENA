"use client";

import { DashboardShell } from "@/features/deep-arena/dashboard-shell";
import { useDeepArena } from "@/features/deep-arena/use-deep-arena";
import { PortfolioView } from "@/features/predict-binary/portfolio-view";
import { usePredictRound } from "@/features/predict-round/use-predict-round";

export default function PortfolioPage() {
    const { error } = useDeepArena();
    const predictRound = usePredictRound();

    return (
        <DashboardShell activeView="portfolio">
            {error ? <div className="error-banner">{error}</div> : null}

            <PortfolioView roundMarket={predictRound.market} />
        </DashboardShell>
    );
}
