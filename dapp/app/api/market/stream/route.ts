import { handleMarketStreamGet } from "@/lib/server/market-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
    return handleMarketStreamGet(request);
}
