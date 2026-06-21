export const revalidate = 30;
export const runtime = "nodejs";

export function GET() {
    return Response.json({
        players: [],
        fetchedAtMs: Date.now(),
        source: "temporary-lightweight",
    });
}
