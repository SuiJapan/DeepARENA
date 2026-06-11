// 一時デバッグスクリプト: バイナリ BET TX をドライランして MoveAbort を再現する。
// 実行: node scripts/debug-dry-run-bet.mjs <quantity> <maxTotalCost> <depositAmount>
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { coinWithBalance, Transaction } from "@mysten/sui/transactions";

const USER = "0x85ec5362331f306b5729fa485cb2f93d1e8380a4b8e55e73be37d5e4126da07a";
const MANAGER = "0xa58791acf113883e3dcf636a50e259244adef4cc33ff4a49ffd43a872a541e92";
const PREDICT_PKG = "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138";
const PREDICT_OBJ = "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a";
const ARENA_PKG = "0xb3b546a75389e222acd043d4ce5a4d85b9a616ec55f98ede5e50d89b019a22aa";
const ARENA_OBJ = "0xdb259dd56458b3308dcd0536ced30e5145d1168dcd958539820e512686025bdf";
const DUSDC = "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC";
const ORACLE = "0x86927a4b747fed4a0a785c65f201dbe98ae769ebf0cf0febe4e55c7419898f1a";
const EXPIRY = 1781118900000n;
const STRIKE = 61816000000000n;
const IS_UP = false;

const quantity = BigInt(process.argv[2]);
const maxTotalCost = BigInt(process.argv[3]);
const depositAmount = BigInt(process.argv[4]);

const client = new SuiJsonRpcClient({
    network: "testnet",
    url: "https://fullnode.testnet.sui.io",
});

const tx = new Transaction();
tx.setSender(USER);
if (depositAmount > 0n) {
    const depositCoin = coinWithBalance({ balance: depositAmount, type: DUSDC });
    tx.moveCall({
        target: `${PREDICT_PKG}::predict_manager::deposit`,
        typeArguments: [DUSDC],
        arguments: [tx.object(MANAGER), depositCoin],
    });
}
tx.moveCall({
    target: `${ARENA_PKG}::bet::open_binary`,
    typeArguments: [DUSDC],
    arguments: [
        tx.object(ARENA_OBJ),
        tx.object(PREDICT_OBJ),
        tx.object(MANAGER),
        tx.object(ORACLE),
        tx.pure.id(ORACLE),
        tx.pure.u64(EXPIRY),
        tx.pure.u64(STRIKE),
        tx.pure.bool(IS_UP),
        tx.pure.u64(quantity),
        tx.pure.u64(maxTotalCost),
        tx.object("0x6"),
    ],
});

try {
    const result = await client.core.simulateTransaction({
        transaction: tx,
        include: { events: true, balanceChanges: true, effects: true },
    });
    const txData = result.Transaction ?? result.transaction ?? result;
    const effects = txData.effects ?? result.effects;
    const status = effects?.status ?? null;
    console.log("STATUS:", JSON.stringify(status));
    if (!status || status.success !== true) {
        console.log(
            "RAW RESULT KEYS:",
            JSON.stringify(Object.keys(result)),
            JSON.stringify(Object.keys(txData ?? {})),
        );
        console.log(
            "FULL:",
            JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v)).slice(
                0,
                2000,
            ),
        );
    }
    const events = txData.events ?? result.events ?? [];
    for (const ev of events) {
        const type = ev.type ?? ev.eventType ?? "?";
        if (String(type).includes("BinaryOpened") || String(type).includes("PositionMinted")) {
            console.log("EVENT:", type);
            console.log(
                "  parsed:",
                JSON.stringify(ev.parsedJson ?? ev.json ?? ev.contents ?? null, (_, v) =>
                    typeof v === "bigint" ? v.toString() : v,
                ),
            );
        }
    }
} catch (err) {
    console.log("SIMULATION ERROR:");
    console.log(err?.message ?? String(err));
    if (err?.cause) console.log("CAUSE:", err.cause?.message ?? String(err.cause));
}
