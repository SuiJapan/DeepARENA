"use client";

import { BinaryPortfolioSection } from "@/features/predict-binary/binary-portfolio-section";
import type { PredictRoundMarket } from "@/features/predict-round/use-predict-round";

export function PortfolioView({ roundMarket }: { roundMarket: PredictRoundMarket | null }) {
    return (
        <section id="portfolio" className="page active" aria-label="Portfolio page">
            <div className="section-block">
                <div className="container">
                    <div className="section-head">
                        <div className="section-no">Personal account</div>
                        <h1 className="section-title">Portfolio</h1>
                    </div>
                    <BinaryPortfolioSection roundMarket={roundMarket} />
                </div>
            </div>
        </section>
    );
}
