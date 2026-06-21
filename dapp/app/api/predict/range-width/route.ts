export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    await request.json().catch(() => null);
    return Response.json({
        ok: false,
        error: "Range width selection is temporarily unavailable",
    });
}
