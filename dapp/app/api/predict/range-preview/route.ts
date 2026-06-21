import { handleRangePreviewPost } from "@/lib/server/predict/range-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
    return handleRangePreviewPost(request);
}
