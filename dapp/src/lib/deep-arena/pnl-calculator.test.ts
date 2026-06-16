import assert from "node:assert/strict";
import { test } from "node:test";
import {
    binaryKey,
    computePnl,
    type OpenedContribution,
    type RedeemContribution,
    rangeKey,
} from "./pnl-calculator.ts";

const ORACLE = "0xabc";
const EXPIRY = 1000n;

function openedBinary(
    managerId: string,
    strike: bigint,
    isUp: boolean,
    quantity: bigint,
    cost: bigint,
    fee: bigint,
): OpenedContribution {
    return {
        managerId,
        cost,
        fee,
        binary: [{ keyStr: binaryKey(ORACLE, EXPIRY, strike, isUp), quantity }],
        range: [],
    };
}

function redeemBinary(
    managerId: string,
    strike: bigint,
    isUp: boolean,
    quantity: bigint,
    payout: bigint,
    timestampMs = 0,
    tieBreak = "",
): RedeemContribution {
    return {
        managerId,
        kind: "binary",
        keyStr: binaryKey(ORACLE, EXPIRY, strike, isUp),
        quantity,
        payout,
        timestampMs,
        tieBreak,
    };
}

test("基本: payout − cost − fee（正の PnL）", () => {
    const opened = [openedBinary("m1", 100n, true, 10n, 50n, 2n)];
    const redeemed = [redeemBinary("m1", 100n, true, 10n, 80n)];
    const result = computePnl(opened, redeemed);
    const m = result.get("m1");
    assert.ok(m);
    assert.equal(m.payout, 80n);
    assert.equal(m.cost, 50n);
    assert.equal(m.fee, 2n);
    assert.equal(m.pnl, 28n); // 80 − 50 − 2
});

test("負の PnL も返す（0 床にしない）", () => {
    const opened = [openedBinary("m1", 100n, true, 10n, 100n, 5n)];
    const redeemed = [redeemBinary("m1", 100n, true, 10n, 20n)];
    const result = computePnl(opened, redeemed);
    assert.equal(result.get("m1")?.pnl, -85n); // 20 − 100 − 5
});

test("直接 redeem（claim を DeepARENA 経由せず）でも payout 計上される", () => {
    // opened は arena 経由、redeem は Predict 層の任意経路（manager_id だけで紐づく）
    const opened = [openedBinary("m1", 100n, true, 10n, 50n, 0n)];
    const redeemed = [redeemBinary("m1", 100n, true, 10n, 90n)];
    assert.equal(computePnl(opened, redeemed).get("m1")?.pnl, 40n);
});

test("arena 外マネージャーの払戻は誤加点しない", () => {
    // m2 は arena で建玉していない（opened 無し）→ redeem があっても結果に出ない
    const opened = [openedBinary("m1", 100n, true, 10n, 50n, 0n)];
    const redeemed = [
        redeemBinary("m1", 100n, true, 10n, 90n),
        redeemBinary("m2", 200n, false, 5n, 500n),
    ];
    const result = computePnl(opened, redeemed);
    assert.equal(result.has("m2"), false);
    assert.equal(result.get("m1")?.pnl, 40n);
});

test("arena 所有数量を超える redeem は上限でクランプ（arena 外建玉分を除外）", () => {
    // arena で 10 建玉、redeem は 15（うち 5 は arena 外で建てた同一キー）
    const opened = [openedBinary("m1", 100n, true, 10n, 50n, 0n)];
    const redeemed = [redeemBinary("m1", 100n, true, 15n, 150n)]; // 単価 10/口
    const result = computePnl(opened, redeemed);
    // 10 口分のみ帰属: 150 * 10 / 15 = 100
    assert.equal(result.get("m1")?.payout, 100n);
    assert.equal(result.get("m1")?.pnl, 50n); // 100 − 50 − 0
});

test("部分 redeem（複数イベント）を累積上限内で合算", () => {
    const opened = [openedBinary("m1", 100n, true, 10n, 40n, 0n)];
    const redeemed = [
        redeemBinary("m1", 100n, true, 4n, 32n, 1),
        redeemBinary("m1", 100n, true, 6n, 60n, 2),
    ];
    const result = computePnl(opened, redeemed);
    assert.equal(result.get("m1")?.payout, 92n); // 32 + 60
    assert.equal(result.get("m1")?.pnl, 52n);
});

test("再建玉: open→redeem→open を累積数量で正しく帰属", () => {
    // arena で計 100 建玉（50+50）、redeem 累計 150（超過 50 は arena 外）
    const opened = [
        openedBinary("m1", 100n, true, 50n, 250n, 0n),
        openedBinary("m1", 100n, true, 50n, 250n, 0n),
    ];
    const redeemed = [redeemBinary("m1", 100n, true, 150n, 1500n, 1)]; // 単価 10
    const result = computePnl(opened, redeemed);
    assert.equal(result.get("m1")?.payout, 1000n); // 100 口分: 1500*100/150
    assert.equal(result.get("m1")?.cost, 500n);
    assert.equal(result.get("m1")?.pnl, 500n);
});

test("Break: 2 レッグの建玉と redeem を別々に帰属", () => {
    // Break = lower DOWN + upper UP
    const opened: OpenedContribution[] = [
        {
            managerId: "m1",
            cost: 30n, // 2 レッグ合計
            fee: 1n,
            binary: [
                { keyStr: binaryKey(ORACLE, EXPIRY, 90n, false), quantity: 10n },
                { keyStr: binaryKey(ORACLE, EXPIRY, 110n, true), quantity: 10n },
            ],
            range: [],
        },
    ];
    const redeemed = [
        redeemBinary("m1", 90n, false, 10n, 25n, 1),
        redeemBinary("m1", 110n, true, 10n, 0n, 2),
    ];
    const result = computePnl(opened, redeemed);
    assert.equal(result.get("m1")?.payout, 25n);
    assert.equal(result.get("m1")?.pnl, -6n); // 25 − 30 − 1
});

test("range の payout 帰属", () => {
    const opened: OpenedContribution[] = [
        {
            managerId: "m1",
            cost: 20n,
            fee: 0n,
            binary: [],
            range: [{ keyStr: rangeKey(ORACLE, EXPIRY, 90n, 110n), quantity: 5n }],
        },
    ];
    const redeemed: RedeemContribution[] = [
        {
            managerId: "m1",
            kind: "range",
            keyStr: rangeKey(ORACLE, EXPIRY, 90n, 110n),
            quantity: 5n,
            payout: 35n,
            timestampMs: 1,
            tieBreak: "",
        },
    ];
    assert.equal(computePnl(opened, redeemed).get("m1")?.pnl, 15n); // 35 − 20
});
