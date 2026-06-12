// 一時デバッグスクリプト: 指定ウォレットの直近トランザクションとイベントを調べ、
// ベット TX がどのイベント(型・フィールド)を発行しているか確認する。
// 実行: node scripts/debug-wallet-txs.mjs <walletAddress> [count]
const FULLNODE = "https://fullnode.testnet.sui.io";
const WALLET = process.argv[2];
const COUNT = Number(process.argv[3] ?? "15");

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

const result = await rpc("suix_queryTransactionBlocks", [
    {
        filter: { FromAddress: WALLET },
        options: { showEvents: true, showEffects: false, showInput: false },
    },
    null,
    COUNT,
    true, // descending = newest first
]);

for (const tx of result.data ?? []) {
    const ts = tx.timestampMs ? new Date(Number(tx.timestampMs)).toISOString() : "no-ts";
    console.log(`--- ${ts} digest=${tx.digest}`);
    for (const ev of tx.events ?? []) {
        const type = ev.type ?? "?";
        const p = ev.parsedJson ?? {};
        const summary = {};
        for (const k of ["trader", "predict_id", "oracle_id", "expiry", "strike", "lower_strike", "higher_strike", "is_up", "quantity", "cost", "manager_id", "quote_asset"]) {
            if (p[k] !== undefined) summary[k] = typeof p[k] === "object" ? JSON.stringify(p[k]).slice(0, 80) : String(p[k]).slice(0, 80);
        }
        console.log(`    event: ${type}`);
        if (Object.keys(summary).length > 0) console.log(`      ${JSON.stringify(summary)}`);
    }
    if ((tx.events ?? []).length === 0) console.log("    (no events)");
}
console.log("total txs returned:", (result.data ?? []).length, "hasNextPage:", result.hasNextPage);
