"use client";

import { RankingSection } from "@/features/deep-arena/ranking-section";

export function RankingView() {
    return (
        <section className="page-view">
            <div className="page-heading">
                <span>Competition overview</span>
                <h1>Ranking</h1>
                <p>Track the leaderboard and activity across the full arena.</p>
            </div>
            <RankingSection />
        </section>
    );
}
