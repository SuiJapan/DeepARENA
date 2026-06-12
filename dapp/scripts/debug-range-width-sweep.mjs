// 一時デバッグスクリプト: range の幅を変えながら get_range_trade_amounts / get_trade_amounts を試す。
// 実行: node scripts/debug-range-width-sweep.mjs
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";

const PREDICT_PKG = "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138";
const PREDICT_OBJ = "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a";
const PREDICT_SERVER = "https://predict-server.testnet.mystenlabs.com";
const FULLNODE = "https://fullnode.testnet.sui.io";
const SENDER = "0x85ec5362331f306b5729fa485cb2f93d1e8380a4b8e55e73be37d5e4126da07a";
const TICK = 1000000000n; // $1
const BUDGET = 10000000n; // 10 DUSDC

const client = new SuiJsonRpcClient({ network: "testnet", url: FULLNODE });

async function fetchJson(url) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
}

const oracles = (await fetchJson(`${PREDICT_SERVER}/predicts/${PREDICT_OBJ}/oracles`))
    .map((o) => ({
        oracleId: o.oracle_id,
        underlyingAsset: o.underlying_asset,
        lifecycle: typeof o.status === "object" ? o.status?.variant : o.status,
        expiryMs: Number(o.expiry),
    }))
    .filter((o) => o.underlyingAsset === "BTC" && o.lifecycle === "active")
    .sort((a, b) => a.expiryMs - b.expiryMs);
const nowMs = Date.now();
const current = oracles.find((o) => o.expiryMs > nowMs);
if (!current) {
    console.log("no active oracle");
    process.exit(0);
}
const prices = await fetchJson(`${PREDICT_SERVER}/oracles/${current.oracleId}/prices`);
const latest = prices.at(-1);
const spot = BigInt(latest.spot);
console.log("now:", new Date(nowMs).toISOString());
console.log("oracle:", current.oracleId, "expiry:", new Date(current.expiryMs).toISOString());
console.log("minutes to expiry:", ((current.expiryMs - nowMs) / 60000).toFixed(1));
console.log("spot:", spot.toString(), `($${(Number(spot) / 1e9).toFixed(0)})`);
const center = (spot / TICK) * TICK; // 近傍グリッドへ丸め

async function trySim(tx, label) {
    try {
        const result = await client.core.simulateTransaction({
            transaction: tx,
            checksEnabled: false,
            include: { commandResults: true },
        });
        if (result.$kind === "FailedTransaction") {
            const err = result.FailedTransaction?.status?.error;
            console.log(`${label}: ABORT ${err?.message ?? "?"}`);
            return;
        }
        const rvs = (result.commandResults ?? []).flatMap((c) => c.returnValues ?? []);
        const decoded = rvs.map((rv) => {
            const b = rv.bcs;
            if (b instanceof Uint8Array && b.length === 8)
                return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true).toString();
            return `bcs(${b?.length})`;
        });
        console.log(`${label}: OK [mintCost, redeemPayout] = ${JSON.stringify(decoded)}`);
    } catch (e) {
        console.log(`${label}: THREW ${e?.message}`);
    }
}

for (const widthTicks of [1000n, 500n, 200n, 100n, 50n, 20n, 10n, 5n, 1n]) {
    const lower = center - TICK * widthTicks;
    const higher = center + TICK * widthTicks;
    const tx = new Transaction();
    tx.setSender(SENDER);
    const key = tx.moveCall({
        target: `${PREDICT_PKG}::range_key::new`,
        arguments: [
            tx.pure.id(current.oracleId),
            tx.pure.u64(current.expiryMs),
            tx.pure.u64(lower),
            tx.pure.u64(higher),
        ],
    });
    tx.moveCall({
        target: `${PREDICT_PKG}::predict::get_range_trade_amounts`,
        arguments: [tx.object(PREDICT_OBJ), tx.object(current.oracleId), key, tx.pure.u64(BUDGET), tx.object("0x6")],
    });
    await trySim(tx, `RANGE width=±$${widthTicks}`);
}

// バイナリ(中心ストライク)も確認
for (const [offsetTicks, isUp] of [[0n, true], [0n, false], [1000n, true], [-1000n, false]]) {
    const strike = center + TICK * offsetTicks;
    const tx = new Transaction();
    tx.setSender(SENDER);
    const key = tx.moveCall({
        target: `${PREDICT_PKG}::market_key::new`,
        arguments: [
            tx.pure.id(current.oracleId),
            tx.pure.u64(current.expiryMs),
            tx.pure.u64(strike),
            tx.pure.bool(isUp),
        ],
    });
    tx.moveCall({
        target: `${PREDICT_PKG}::predict::get_trade_amounts`,
        arguments: [tx.object(PREDICT_OBJ), tx.object(current.oracleId), key, tx.pure.u64(BUDGET), tx.object("0x6")],
    });
    await trySim(tx, `BINARY strike=center${offsetTicks >= 0n ? "+" : ""}$${offsetTicks} ${isUp ? "UP" : "DOWN"}`);
}
