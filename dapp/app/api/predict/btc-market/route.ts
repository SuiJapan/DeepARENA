import { handleBtcMarketGet } from "@/lib/server/predict/btc-market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
    return handleBtcMarketGet();
}
