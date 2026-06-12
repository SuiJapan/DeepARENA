// 一時デバッグスクリプト: portfolio API の実レスポンスを binary-portfolio-section.tsx と
// 同じロジックで処理し、Current Positions / Your history に何が表示されるか再現する。
// 実行: node scripts/debug-portfolio-render.mjs /tmp/portfolio-3001.json /tmp/oracle-states-res.json
import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync(process.argv[2] ?? "/tmp/portfolio-3001.json", "utf8"));
const oracleStates = JSON.parse(readFileSync(process.argv[3] ?? "/tmp/oracle-states-res.json", "utf8"));

const nowMs = Date.now();
const positionKey = (e) => [e.oracleId, String(e.expiryMs), String(e.strike), e.isUp ? "UP" : "DOWN"].join(":");
const eventKey = (e) =>
    [e.digest ?? "no-digest", e.oracleId, String(e.expiryMs), String(e.strike), e.isUp ? "UP" : "DOWN", String(e.quantity), String(e.cost), e.timestampMs ?? "no-time"].join(":");

// buildBreakGroups と同じ: 同一 digest 内の DOWN+UP ペアを BREAK とみなす
const byDigest = new Map();
for (const e of data.minted) {
    if (!e.digest) continue;
    const arr = byDigest.get(e.digest) ?? [];
    arr.push(e);
    byDigest.set(e.digest, arr);
}
const breakLegKeys = new Set();
const breakGroups = [];
for (const [digest, events] of byDigest) {
    for (const lower of events.filter((e) => !e.isUp)) {
        const upper = events.find(
            (e) => e.isUp && e.managerId === lower.managerId && e.oracleId === lower.oracleId &&
                e.expiryMs === lower.expiryMs && BigInt(e.strike) > BigInt(lower.strike),
        );
        if (!upper) continue;
        breakLegKeys.add(eventKey(lower));
        breakLegKeys.add(eventKey(upper));
        breakGroups.push({ digest, lower, upper });
    }
}

// buildPositions 簡略版 (claimedKeys は空なので claim 分岐は省略)
const grouped = new Map();
for (const e of data.minted) {
    const key = positionKey(e);
    const cur = grouped.get(key);
    if (!cur) {
        grouped.set(key, { key, expiryMs: e.expiryMs, events: [e] });
    } else {
        cur.events.push(e);
    }
}
const claimed = new Set(data.claimedKeys);
const currentBinary = [];
for (const pos of grouped.values()) {
    const status = claimed.has(pos.key) ? "Claimed" : nowMs < pos.expiryMs ? "Open" : "(settled-side)";
    const isCurrent = pos.expiryMs > nowMs && status === "Open";
    const isBreakLeg = pos.events.some((e) => breakLegKeys.has(eventKey(e)));
    if (isCurrent && !isBreakLeg) currentBinary.push(pos);
}

console.log("now:", new Date(nowMs).toISOString());
console.log("== Current Positions (Binary) ==", currentBinary.length);
for (const pos of currentBinary) {
    console.log("  ", pos.key.slice(0, 20), "expiry=", new Date(pos.expiryMs).toISOString(), "events=", pos.events.length);
}
const currentRange = data.rangeMinted.filter((e) => nowMs < e.expiryMs);
console.log("== Current Positions (Range) ==", currentRange.length);
const currentBreak = breakGroups.filter((g) => nowMs < g.lower.expiryMs);
console.log("== Current Positions (Break) ==", currentBreak.length);

// history: current 表示中の positionGroupKey は除外される
const currentKeys = new Set(currentBinary.map((p) => p.key));
const historyBinary = data.minted.filter(
    (e) => !breakLegKeys.has(eventKey(e)) && !currentKeys.has(positionKey(e)),
);
console.log("== Your history (Binary rows) ==", historyBinary.length);
const latest = [...data.minted].sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0))[0];
console.log("latest bet:", new Date(latest.timestampMs).toISOString(), "-> shown in:",
    currentKeys.has(positionKey(latest)) ? "Current Positions (history からは除外)" : "Your history");
