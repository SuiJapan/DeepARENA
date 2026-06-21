"use client";

import { RankingSection } from "@/features/deep-arena/ranking-section";

export function RankingView() {
    return (
        <section id="leaderboard" className="page active" aria-label="Leaderboard page">
            <div className="section-block">
                <div className="container">
                    <div className="section-head">
                        <h1 className="section-title" style={{ fontWeight: 700 }}>
                            Leaderboard
                        </h1>
                    </div>
                    <RankingSection />
                </div>
            </div>
        </section>
    );
}
