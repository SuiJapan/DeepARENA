// 一時デバッグスクリプト: range-preview API と同じ手順を再現し、どこで失敗するか特定する。
// 実行: node scripts/debug-range-preview.mjs [betAmountAtomic]
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";

const PREDICT_PKG = "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138";
const PREDICT_OBJ = "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a";
const PREDICT_SERVER = "https://predict-server.testnet.mystenlabs.com";
const FULLNODE = "https://fullnode.testnet.sui.io";
const SENDER = "0x85ec5362331f306b5729fa485cb2f93d1e8380a4b8e55e73be37d5e4126da07a";
const GRID_TICKS = 100000n;
const FIXED_RANGE_WIDTH_TICKS = 1000n;
const BUDGET = BigInt(process.argv[2] ?? "10000000"); // 10 DUSDC

const client = new SuiJsonRpcClient({ network: "testnet", url: FULLNODE });

async function fetchJson(url) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
}

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

// 1. オラクル一覧
const oracles = (await fetchJson(`${PREDICT_SERVER}/predicts/${PREDICT_OBJ}/oracles`))
    .map((o) => ({
        oracleId: o.oracle_id,
        underlyingAsset: o.underlying_asset,
        lifecycle: typeof o.status === "object" ? o.status?.variant : o.status,
        expiryMs: Number(o.expiry),
        activatedAtMs: o.activated_at ? Number(o.activated_at) : null,
    }))
    .filter((o) => o.underlyingAsset === "BTC")
    .sort((a, b) => a.expiryMs - b.expiryMs);

const nowMs = Date.now();
const boundary = [...oracles].reverse().find((o) => o.expiryMs <= nowMs) ?? null;
const boundaryMs = boundary?.expiryMs ?? null;
const futureActive = oracles.filter((o) => {
    if (o.lifecycle !== "active") return false;
    if (boundaryMs === null) return o.expiryMs > nowMs;
    if (o.expiryMs <= boundaryMs) return false;
    return o.activatedAtMs === null || o.activatedAtMs <= boundaryMs;
});
const current = futureActive[0] ?? null;
const previous = current
    ? ([...oracles].reverse().find((o) => o.expiryMs < current.expiryMs) ?? null)
    : null;
console.log("now:", new Date(nowMs).toISOString());
console.log("BTC oracles:", oracles.map((o) => `${o.oracleId.slice(0, 8)} ${o.lifecycle} exp=${new Date(o.expiryMs).toISOString()}`));
console.log("current:", current ? `${current.oracleId} exp=${new Date(current.expiryMs).toISOString()}` : null);
console.log("previous:", previous ? `${previous.oracleId} exp=${new Date(previous.expiryMs).toISOString()}` : null);
if (!current || !previous) {
    console.log("=> NO_ACTIVE_ROUND (current or previous oracle missing)");
    process.exit(0);
}
const bettingCloseMs = current.expiryMs - 5 * 60 * 1000;
console.log("bettingClose:", new Date(bettingCloseMs).toISOString(), "open?", nowMs < bettingCloseMs);

// 2. 前ラウンドの清算価格
const prevObj = await rpc("sui_getObject", [previous.oracleId, { showContent: true }]);
const prevFields = prevObj?.data?.content?.fields ?? {};
const settlementRaw =
    prevFields.settlement_price?.fields?.value ??
    prevFields.settlement_price?.vec?.[0] ??
    prevFields.settlement_price ??
    null;
console.log("previous settlement_price raw:", JSON.stringify(prevFields.settlement_price)?.slice(0, 200));

// 3. グリッド (OracleCreated イベント)
let cursor = null;
let grid = null;
let fallbackGrid = null;
for (let page = 0; page < 20 && !grid; page += 1) {
    const result = await rpc("suix_queryEvents", [
        { MoveEventType: `${PREDICT_PKG}::registry::OracleCreated` },
        cursor,
        50,
        true,
    ]);
    for (const item of result.data ?? []) {
        const p = item.parsedJson ?? {};
        const oid = p.oracle_id?.id ?? p.oracle_id?.bytes ?? p.oracle_id;
        const minStrike = p.min_strike;
        const tickSize = p.tick_size;
        if (!minStrike || !tickSize) continue;
        if (oid === current.oracleId) {
            grid = { minStrike: BigInt(minStrike), tickSize: BigInt(tickSize), source: "exact" };
            break;
        }
        if (p.underlying_asset === "BTC") {
            fallbackGrid = { minStrike: BigInt(minStrike), tickSize: BigInt(tickSize), source: "fallback", oid };
        }
    }
    if (result.hasNextPage !== true) break;
    cursor = result.nextCursor;
}
grid = grid ?? fallbackGrid;
console.log("grid:", grid ? { minStrike: grid.minStrike.toString(), tickSize: grid.tickSize.toString(), source: grid.source } : null);
if (!grid || !settlementRaw) {
    console.log("=> grid or settlement price unavailable; round would be LOCKING/ERROR");
    process.exit(0);
}

// 4. ストライク計算 (round.ts と同じ)
const openingSpot = BigInt(typeof settlementRaw === "string" ? settlementRaw : settlementRaw.toString());
const maxStrike = grid.minStrike + grid.tickSize * GRID_TICKS;
const rawIndex = openingSpot <= grid.minStrike ? 0n : (openingSpot - grid.minStrike) / grid.tickSize;
const lowerGrid = grid.minStrike + rawIndex * grid.tickSize;
const upperGrid = lowerGrid + grid.tickSize;
const nearest = (openingSpot - lowerGrid) > (upperGrid - openingSpot) ? upperGrid : lowerGrid;
const minCenter = grid.minStrike + grid.tickSize;
const maxCenter = maxStrike - grid.tickSize;
const binaryStrike = nearest < minCenter ? minCenter : nearest > maxCenter ? maxCenter : nearest;
const widthRaw = grid.tickSize * FIXED_RANGE_WIDTH_TICKS;
const lowerStrike = binaryStrike - widthRaw;
const higherStrike = binaryStrike + widthRaw;
console.log("openingSpot:", openingSpot.toString());
console.log("binaryStrike:", binaryStrike.toString());
console.log("range:", lowerStrike.toString(), "-", higherStrike.toString());
console.log("fixedMarket valid?",
    lowerStrike < higherStrike &&
    lowerStrike >= grid.minStrike &&
    higherStrike <= maxStrike &&
    (lowerStrike - grid.minStrike) % grid.tickSize === 0n &&
    (higherStrike - grid.minStrike) % grid.tickSize === 0n,
);

// 5. RANGE プレビュー (単発 + バッチ)
function addRangeKey(tx) {
    return tx.moveCall({
        target: `${PREDICT_PKG}::range_key::new`,
        arguments: [
            tx.pure.id(current.oracleId),
            tx.pure.u64(current.expiryMs),
            tx.pure.u64(lowerStrike),
            tx.pure.u64(higherStrike),
        ],
    });
}
function addMarketKey(tx, strike, isUp) {
    return tx.moveCall({
        target: `${PREDICT_PKG}::market_key::new`,
        arguments: [
            tx.pure.id(current.oracleId),
            tx.pure.u64(current.expiryMs),
            tx.pure.u64(strike),
            tx.pure.bool(isUp),
        ],
    });
}

async function simulate(tx, label) {
    try {
        const result = await client.core.simulateTransaction({
            transaction: tx,
            checksEnabled: false,
            include: { commandResults: true },
        });
        if (result.$kind === "FailedTransaction") {
            console.log(`${label}: FailedTransaction`);
            console.log(
                "  full:",
                JSON.stringify(
                    result,
                    (_, v) =>
                        typeof v === "bigint"
                            ? v.toString()
                            : v instanceof Uint8Array
                              ? `u8[${v.length}]`
                              : v,
                )?.slice(0, 1500),
            );
            return null;
        }
        const commands = result.commandResults ?? [];
        console.log(`${label}: OK commands=${commands.length}`);
        for (const [i, command] of commands.entries()) {
            const rvs = command.returnValues ?? [];
            const decoded = rvs.map((rv) => {
                const bytes = rv.bcs;
                if (bytes instanceof Uint8Array && bytes.length === 8) {
                    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true).toString();
                }
                if (bytes instanceof Uint8Array && bytes.length === 16) {
                    const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
                    return [view.getBigUint64(0, true).toString(), view.getBigUint64(8, true).toString()];
                }
                return `bcs(${bytes instanceof Uint8Array ? bytes.length : typeof bytes})`;
            });
            if (decoded.length > 0) console.log(`  cmd[${i}]`, JSON.stringify(decoded));
        }
        return result;
    } catch (err) {
        console.log(`${label}: THREW`, err?.message ?? String(err));
        if (err?.cause) console.log("  cause:", err.cause?.message ?? String(err.cause));
        return null;
    }
}

// 単発 RANGE preview (quantity = budget)
{
    const tx = new Transaction();
    tx.setSender(SENDER);
    const key = addRangeKey(tx);
    tx.moveCall({
        target: `${PREDICT_PKG}::predict::get_range_trade_amounts`,
        arguments: [tx.object(PREDICT_OBJ), tx.object(current.oracleId), key, tx.pure.u64(BUDGET), tx.object("0x6")],
    });
    await simulate(tx, `RANGE single quantity=${BUDGET}`);
}

// バッチ RANGE preview (本番と同じ候補数量)
{
    const quantities = [BUDGET, (BUDGET * 3n) / 4n, BUDGET / 2n, BUDGET / 4n, 1n];
    const tx = new Transaction();
    tx.setSender(SENDER);
    for (const q of quantities) {
        const key = addRangeKey(tx);
        tx.moveCall({
            target: `${PREDICT_PKG}::predict::get_range_trade_amounts`,
            arguments: [tx.object(PREDICT_OBJ), tx.object(current.oracleId), key, tx.pure.u64(q), tx.object("0x6")],
        });
    }
    await simulate(tx, `RANGE batch quantities=${quantities.join(",")}`);
}

// BREAK legs バッチ (lower DOWN / upper UP)
{
    const legBudget = BUDGET / 2n;
    const quantities = [legBudget, (legBudget * 3n) / 4n, legBudget / 2n, legBudget / 4n, 1n];
    const tx = new Transaction();
    tx.setSender(SENDER);
    for (const q of quantities) {
        const key = addMarketKey(tx, lowerStrike, false);
        tx.moveCall({
            target: `${PREDICT_PKG}::predict::get_trade_amounts`,
            arguments: [tx.object(PREDICT_OBJ), tx.object(current.oracleId), key, tx.pure.u64(q), tx.object("0x6")],
        });
    }
    for (const q of quantities) {
        const key = addMarketKey(tx, higherStrike, true);
        tx.moveCall({
            target: `${PREDICT_PKG}::predict::get_trade_amounts`,
            arguments: [tx.object(PREDICT_OBJ), tx.object(current.oracleId), key, tx.pure.u64(q), tx.object("0x6")],
        });
    }
    await simulate(tx, "BREAK legs batch");
}
