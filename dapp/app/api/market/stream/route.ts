export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
    const body = `data: ${JSON.stringify({
        type: "status",
        status: "error",
        message: "Market stream is temporarily paused",
    })}\n\n`;
    return new Response(body, {
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}
