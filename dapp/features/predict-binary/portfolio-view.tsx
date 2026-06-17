"use client";

import { BinaryPortfolioSection } from "@/features/predict-binary/binary-portfolio-section";
import type { PredictRoundMarket } from "@/features/predict-round/use-predict-round";

export function PortfolioView({ roundMarket }: { roundMarket: PredictRoundMarket | null }) {
    return (
        <section className="page-view">
            <div className="page-heading">
                <span>Personal account</span>
                <h1>Portfolio</h1>
            </div>
            <BinaryPortfolioSection roundMarket={roundMarket} />
        </section>
    );
}
