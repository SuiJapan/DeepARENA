import { handleBinaryPreviewPost } from "@/lib/server/predict/binary-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
    return handleBinaryPreviewPost(request);
}
