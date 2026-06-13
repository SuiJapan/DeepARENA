// 一時デバッグスクリプト: 直近の PositionMinted / RangeMinted イベント(降順)を確認し、
// 指定ウォレットのベットが先頭ページ付近に存在するか調べる。
// 実行: node scripts/debug-recent-mints.mjs [walletAddress]
const FULLNODE = "https://fullnode.testnet.sui.io";
const PREDICT_PKG = "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138";
const WALLET = (process.argv[2] ?? "").toLowerCase();

async function rpc(method, params) {
    const res = await fetch(FULLNODE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const payload = await res.json();
    if (!payload.result) throw new Error(`RPC ${method} failed: ${JSON.stringify(payload).slice(0, 300)}`);
    return payload.result;
}

for (const eventName of ["PositionMinted", "RangeMinted"]) {
    const eventType = `${PREDICT_PKG}::predict::${eventName}`;
    let cursor = null;
    let found = 0;
    console.log(`=== ${eventName} (descending, first 5 pages) ===`);
    for (let page = 0; page < 5; page += 1) {
        const result = await rpc("suix_queryEvents", [
            { MoveEventType: eventType },
            cursor,
            50,
            true, // descending
        ]);
        for (const item of result.data ?? []) {
            const p = item.parsedJson ?? {};
            const trader = (p.trader ?? "").toLowerCase();
            const ts = item.timestampMs ? new Date(Number(item.timestampMs)).toISOString() : "no-ts";
            if (page === 0 && (result.data ?? []).indexOf(item) < 3) {
                console.log(`  [latest] ${ts} trader=${trader} digest=${item.id?.txDigest?.slice(0, 12)}`);
            }
            if (WALLET && trader === WALLET) {
                found += 1;
                if (found <= 5) {
                    console.log(`  [MATCH p${page}] ${ts} cost=${p.cost} qty=${p.quantity} digest=${item.id?.txDigest?.slice(0, 12)}`);
                }
            }
        }
        if (result.hasNextPage !== true) break;
        cursor = result.nextCursor;
    }
    console.log(`  matches for wallet in first 5 pages: ${found}`);
}
