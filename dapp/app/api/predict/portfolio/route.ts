export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    await request.json().catch(() => null);
    return Response.json({
        minted: [],
        rangeMinted: [],
        redeemed: [],
        claimedKeys: [],
        managerBalances: {},
        positionBalances: {},
        rangePositionBalances: {},
        pagesInfo: {
            mintedPagesRead: 0,
            mintedReachedLimit: false,
            rangePagesRead: 0,
            rangeReachedLimit: false,
            redeemedPagesRead: 0,
            redeemedReachedLimit: false,
        },
    });
}
