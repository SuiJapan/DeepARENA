import type { NextRequest } from "next/server";
import { handlePredictPortfolioPost } from "@/lib/server/predict/portfolio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
    return handlePredictPortfolioPost(request);
}
