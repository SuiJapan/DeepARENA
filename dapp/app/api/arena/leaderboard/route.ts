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
// PnL 再構築は重い（全 redeem イベントを走査）。同一 isolate 内では一定時間キャッシュし、
// リクエストごとの再スキャンを避ける。
const CACHE_TTL_MS = 60_000;
let cache: { players: PlayerSummary[]; ts: number } | null = null;

export async function GET(): Promise<NextResponse<LeaderboardResponse>> {
    const arenaId = deepArenaMockConfig.arenaObjectId;

    if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
        return NextResponse.json({ players: cache.players, arenaId, fetchedAtMs: cache.ts });
    }

    try {
        const client = new ContractDeepArenaClient(deepArenaMockConfig);
        const players = await client.listPlayers();
        lastSuccessfulPlayers = players;
        cache = { players, ts: Date.now() };
        return NextResponse.json({ players, arenaId, fetchedAtMs: cache.ts });
    } catch (caught) {
        const error = caught instanceof Error ? caught.message : "Failed to fetch leaderboard";
        const players = lastSuccessfulPlayers ?? [];
        return NextResponse.json({ players, arenaId, fetchedAtMs: Date.now(), error });
    }
}
