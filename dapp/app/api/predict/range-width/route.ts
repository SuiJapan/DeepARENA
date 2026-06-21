import { handleRangeWidthPost } from "@/lib/server/predict/range-width";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
    return handleRangeWidthPost(request);
}
