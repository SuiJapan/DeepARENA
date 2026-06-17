import { handleArenaLeaderboardGet } from "@/lib/server/arena-leaderboard";

export const revalidate = 30;
export const runtime = "nodejs";

export function GET() {
    return handleArenaLeaderboardGet();
}
