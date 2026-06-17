import { NextResponse } from "next/server";
import { deepArenaMockConfig } from "@/lib/deep-arena/config";
import { ContractDeepArenaClient } from "@/lib/deep-arena/contract-client";
import type { PlayerSummary } from "@/lib/deep-arena/types";

interface LeaderboardResponse {
    players: PlayerSummary[];
    arenaId: string;
    fetchedAtMs: number;
    error?: string;
}

let lastSuccessfulPlayers: PlayerSummary[] | null = null;

export async function handleArenaLeaderboardGet(): Promise<NextResponse<LeaderboardResponse>> {
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
