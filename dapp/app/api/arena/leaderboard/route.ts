import { NextResponse } from "next/server";
import { deepArenaMockConfig } from "@/src/lib/deep-arena/config";
import { ContractDeepArenaClient } from "@/src/lib/deep-arena/contract-client";
import type { PlayerSummary } from "@/src/lib/deep-arena/types";

export const revalidate = 30;
export const runtime = "nodejs";

interface LeaderboardResponse {
    players: PlayerSummary[];
    arenaId: string;
    fetchedAtMs: number;
    error?: string;
}

let lastSuccessfulPlayers: PlayerSummary[] | null = null;

export async function GET(): Promise<NextResponse<LeaderboardResponse>> {
    const arenaId = deepArenaMockConfig.arenaObjectId;
    try {
        const client = new ContractDeepArenaClient(deepArenaMockConfig);
        const players = await client.listPlayers();
        lastSuccessfulPlayers = players;
        return NextResponse.json({ players, arenaId, fetchedAtMs: Date.now() });
    } catch (caught) {
        const error = caught instanceof Error ? caught.message : "Failed to fetch leaderboard";
        const players = lastSuccessfulPlayers ?? [];
        return NextResponse.json({ players, arenaId, fetchedAtMs: Date.now(), error });
    }
}
