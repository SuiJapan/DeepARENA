"use client";

import { RankingSection } from "@/features/deep-arena/ranking-section";

export function RankingView() {
    return (
        <section id="leaderboard" className="page active" aria-label="Leaderboard page">
            <div className="section-block">
                <div className="container">
                    <div className="section-head">
                        <div className="section-no">Live standings</div>
                        <h1 className="section-title page-title">Leaderboard</h1>
                    </div>
                    <RankingSection />
                </div>
            </div>
        </section>
    );
}
