import assert from "node:assert/strict";
import test from "node:test";
import { bcs } from "@mysten/sui/bcs";
import { readSuiEventPayload, readSuiEventPayloads } from "./events.ts";
import { formatBinaryOddsFromQuantity } from "./odds.ts";
import { findBudgetedTradePreview } from "./preview.ts";
import { decodeAllTradeAmountReturns } from "./preview-decode.ts";

test("formats live odds as quantity divided by mint cost", () => {
    assert.equal(formatBinaryOddsFromQuantity(18_000_000n, 10_000_000n), "1.80x");
});

test("does not use redeem payout to format binary odds", () => {
    const quantity = 18_000_000n;
    const mintCost = 10_000_000n;
    const liveBidRedeemPayout = 2_000_000n;

    assert.equal(formatBinaryOddsFromQuantity(quantity, mintCost), "1.80x");
    assert.notEqual(
        formatBinaryOddsFromQuantity(quantity, mintCost),
        `${(Number(liveBidRedeemPayout) / Number(mintCost)).toFixed(2)}x`,
    );
});

test("returns unavailable odds for invalid quantity or cost", () => {
    assert.equal(formatBinaryOddsFromQuantity(0n, 10_000_000n), "--");
    assert.equal(formatBinaryOddsFromQuantity(18_000_000n, 0n), "--");
});

test("starts budgeted preview from quantity one instead of a fixed million-unit minimum", async () => {
    const tried: bigint[] = [];
    const result = await findBudgetedTradePreview({
        budget: 111_000_000n,
        preview: async (quantity) => {
            tried.push(quantity);
            return { mintCost: quantity * 2n, redeemPayout: quantity };
        },
    });

    assert.equal(tried[0], 1n);
    assert.equal(result.firstTriedQuantity, 1n);
    assert.equal(result.quantity, 55_500_000n);
    assert.equal(result.mintCost, 111_000_000n);
});

test("raises quantity when tiny candidates have zero mint cost", async () => {
    const tried: bigint[] = [];
    const result = await findBudgetedTradePreview({
        budget: 10n,
        preview: async (quantity) => {
            tried.push(quantity);
            return {
                mintCost: quantity < 8n ? 0n : quantity / 2n,
                redeemPayout: quantity,
            };
        },
    });

    assert.deepEqual(tried.slice(0, 4), [1n, 2n, 4n, 8n]);
    assert.equal(result.quantity, 21n);
    assert.equal(result.mintCost, 10n);
});

test("builds preview attempts before reporting no mintable quantity", async () => {
    const tried: bigint[] = [];
    await assert.rejects(
        findBudgetedTradePreview({
            budget: 11_000_000n,
            preview: async (quantity) => {
                tried.push(quantity);
                return { mintCost: 0n, redeemPayout: quantity };
            },
            createNoMintableQuantityError: ({ firstTriedQuantity, lastTriedQuantity, attempts }) =>
                new Error(
                    `first=${firstTriedQuantity};last=${lastTriedQuantity};attempts=${attempts}`,
                ),
        }),
        /first=1;last=\d+;attempts=96/,
    );

    assert.equal(tried[0], 1n);
    assert.equal(tried.length, 96);
});

test("reads Sui event payloads from parsedJson", () => {
    const payload = readSuiEventPayload({
        parsedJson: {
            manager_id: "0xmanager",
            owner: "0xowner",
        },
    });

    assert.deepEqual(payload, {
        manager_id: "0xmanager",
        owner: "0xowner",
    });
});

test("prefers Sui event parsedJson payloads when both payload shapes exist", () => {
    const payload = readSuiEventPayload({
        json: {
            manager_id: "0xjson",
        },
        parsedJson: {
            manager_id: "0xparsed",
        },
    });

    assert.deepEqual(payload, {
        manager_id: "0xparsed",
    });
});

test("reads both Sui event payload shapes for diagnostics", () => {
    const payloads = readSuiEventPayloads({
        json: {
            manager_id: "0xjson",
        },
        parsedJson: {
            manager_id: "0xparsed",
        },
    });

    assert.deepEqual(payloads, {
        parsedJson: {
            manager_id: "0xparsed",
        },
        json: {
            manager_id: "0xjson",
        },
    });
});

test("decodes all trade amount returns from multiple command results", () => {
    const result = {
        $kind: "Transaction",
        commandResults: [
            { returnValues: [] },
            {
                returnValues: [
                    { bcs: bcs.U64.serialize(10n).toBytes() },
                    { bcs: bcs.U64.serialize(20n).toBytes() },
                ],
            },
            {
                returnValues: [
                    { bcs: bcs.U64.serialize(30n).toBytes() },
                    { bcs: bcs.U64.serialize(40n).toBytes() },
                ],
            },
        ],
    };

    assert.deepEqual(decodeAllTradeAmountReturns(result), [
        { mintCost: 10n, redeemPayout: 20n },
        { mintCost: 30n, redeemPayout: 40n },
    ]);
});

test("decodes all trade amount returns from 16-byte tuple values", () => {
    const tuple = new Uint8Array(16);
    const view = new DataView(tuple.buffer);
    view.setBigUint64(0, 55n, true);
    view.setBigUint64(8, 89n, true);
    const result = {
        $kind: "Transaction",
        commandResults: [{ returnValues: [{ bcs: tuple }] }],
    };

    assert.deepEqual(decodeAllTradeAmountReturns(result), [{ mintCost: 55n, redeemPayout: 89n }]);
});
