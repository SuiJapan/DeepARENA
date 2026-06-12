// 一時デバッグスクリプト: portfolio refresh() と同じイベント走査を再現し、
// fullnode のレスポンス(429 等)を観測する。
// 実行: node scripts/debug-portfolio-fetch.mjs
const FULLNODE = "https://fullnode.testnet.sui.io";
const PREDICT_PKG = "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138";
const EVENT_TYPES = [
    `${PREDICT_PKG}::predict::PositionMinted`,
    `${PREDICT_PKG}::predict::RangeMinted`,
    `${PREDICT_PKG}::predict::PositionRedeemed`,
];
const MAX_PAGES = 40;
const PAGE_SIZE = 50;

const statusCounts = new Map();
let totalRequests = 0;
let totalEvents = 0;
const startMs = Date.now();

async function queryPages(eventType) {
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
        totalRequests += 1;
        const res = await fetch(FULLNODE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: page + 1,
                method: "suix_queryEvents",
                params: [{ MoveEventType: eventType }, cursor, PAGE_SIZE, true],
            }),
        });
        statusCounts.set(res.status, (statusCounts.get(res.status) ?? 0) + 1);
        if (!res.ok) {
            const headers = {};
            for (const [k, v] of res.headers.entries()) {
                if (/access-control|retry-after|ratelimit/i.test(k)) headers[k] = v;
            }
            console.log(`${eventType.split("::").pop()} page=${page} -> HTTP ${res.status}`, headers);
            const text = await res.text();
            console.log("  body:", text.slice(0, 200));
            return { failedAtPage: page };
        }
        const payload = await res.json();
        if (payload.error) {
            console.log(`${eventType.split("::").pop()} page=${page} -> RPC error:`, JSON.stringify(payload.error).slice(0, 200));
            return { failedAtPage: page };
        }
        const data = payload.result?.data ?? [];
        totalEvents += data.length;
        if (payload.result?.hasNextPage !== true) {
            console.log(`${eventType.split("::").pop()}: done pages=${page + 1} events so far=${totalEvents}`);
            return { pages: page + 1 };
        }
        cursor = payload.result.nextCursor;
    }
    console.log(`${eventType.split("::").pop()}: reached page limit ${MAX_PAGES}`);
    return { pages: MAX_PAGES };
}

for (const eventType of EVENT_TYPES) {
    await queryPages(eventType);
}
console.log("---");
console.log("elapsed ms:", Date.now() - startMs);
console.log("total requests:", totalRequests, "total events:", totalEvents);
console.log("status counts:", Object.fromEntries(statusCounts));
