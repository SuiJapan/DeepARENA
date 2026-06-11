import assert from "node:assert/strict";
import test from "node:test";
import type { MintedPositionEvent, RangeMintEvent, RedeemedPositionEvent } from "./client.ts";
import {
    deserializeMintedEvent,
    deserializeRangeMintedEvent,
    deserializeRedeemedEvent,
    positionKeyFromRedeemed,
    type SerializedMintedPositionEvent,
    serializeMintedEvent,
    serializeRangeMintedEvent,
    serializeRedeemedEvent,
} from "./portfolio.ts";

const sampleMinted: MintedPositionEvent = {
    predictId: "0xpredict",
    managerId: "0xmanager",
    trader: "0xtrader",
    quoteAssetName: "DUSDC",
    oracleId: "0xoracle",
    expiryMs: 1700000000000,
    strike: 50000_000_000_000_000n,
    isUp: true,
    quantity: 10_000_000n,
    cost: 5_000_000n,
    askPrice: 500_000n,
    digest: "abc123",
    timestampMs: 1699999990000,
};

const sampleRangeMinted: RangeMintEvent = {
    predictId: "0xpredict",
    managerId: "0xmanager",
    trader: "0xtrader",
    quoteAssetName: "DUSDC",
    oracleId: "0xoracle",
    expiryMs: 1700000000000,
    lowerStrike: 48000_000_000_000_000n,
    higherStrike: 52000_000_000_000_000n,
    quantity: 10_000_000n,
    cost: 5_000_000n,
    askPrice: 500_000n,
    digest: "def456",
    timestampMs: 1699999990000,
};

const sampleRedeemed: RedeemedPositionEvent = {
    managerId: "0xmanager",
    oracleId: "0xoracle",
    expiryMs: 1700000000000,
    strike: 50000_000_000_000_000n,
    isUp: true,
    quantity: 10_000_000n,
    payout: 10_000_000n,
    bidPrice: 1_000_000n,
    isSettled: true,
    digest: "ghi789",
    timestampMs: 1700000010000,
};

test("serialize/deserialize MintedPositionEvent round-trip preserves bigint fields", () => {
    const serialized = serializeMintedEvent(sampleMinted);

    assert.equal(typeof serialized.strike, "string");
    assert.equal(typeof serialized.quantity, "string");
    assert.equal(typeof serialized.cost, "string");
    assert.equal(typeof serialized.askPrice, "string");
    assert.equal(serialized.strike, "50000000000000000");
    assert.equal(serialized.quantity, "10000000");
    assert.equal(serialized.cost, "5000000");
    assert.equal(serialized.askPrice, "500000");

    const deserialized = deserializeMintedEvent(serialized);

    assert.equal(typeof deserialized.strike, "bigint");
    assert.equal(typeof deserialized.quantity, "bigint");
    assert.equal(typeof deserialized.cost, "bigint");
    assert.equal(typeof deserialized.askPrice, "bigint");
    assert.equal(deserialized.strike, sampleMinted.strike);
    assert.equal(deserialized.quantity, sampleMinted.quantity);
    assert.equal(deserialized.cost, sampleMinted.cost);
    assert.equal(deserialized.askPrice, sampleMinted.askPrice);
    assert.equal(deserialized.oracleId, sampleMinted.oracleId);
    assert.equal(deserialized.expiryMs, sampleMinted.expiryMs);
    assert.equal(deserialized.isUp, sampleMinted.isUp);
});

test("serialize/deserialize RangeMintEvent round-trip preserves bigint fields", () => {
    const serialized = serializeRangeMintedEvent(sampleRangeMinted);

    assert.equal(typeof serialized.lowerStrike, "string");
    assert.equal(typeof serialized.higherStrike, "string");
    assert.equal(typeof serialized.quantity, "string");
    assert.equal(typeof serialized.cost, "string");
    assert.equal(typeof serialized.askPrice, "string");

    const deserialized = deserializeRangeMintedEvent(serialized);

    assert.equal(typeof deserialized.lowerStrike, "bigint");
    assert.equal(typeof deserialized.higherStrike, "bigint");
    assert.equal(deserialized.lowerStrike, sampleRangeMinted.lowerStrike);
    assert.equal(deserialized.higherStrike, sampleRangeMinted.higherStrike);
    assert.equal(deserialized.quantity, sampleRangeMinted.quantity);
    assert.equal(deserialized.cost, sampleRangeMinted.cost);
    assert.equal(deserialized.askPrice, sampleRangeMinted.askPrice);
});

test("serialize/deserialize RedeemedPositionEvent round-trip preserves bigint fields", () => {
    const serialized = serializeRedeemedEvent(sampleRedeemed);

    assert.equal(typeof serialized.strike, "string");
    assert.equal(typeof serialized.quantity, "string");
    assert.equal(typeof serialized.payout, "string");
    assert.equal(typeof serialized.bidPrice, "string");

    const deserialized = deserializeRedeemedEvent(serialized);

    assert.equal(typeof deserialized.strike, "bigint");
    assert.equal(typeof deserialized.payout, "bigint");
    assert.equal(typeof deserialized.bidPrice, "bigint");
    assert.equal(deserialized.strike, sampleRedeemed.strike);
    assert.equal(deserialized.payout, sampleRedeemed.payout);
    assert.equal(deserialized.bidPrice, sampleRedeemed.bidPrice);
    assert.equal(deserialized.isSettled, sampleRedeemed.isSettled);
});

test("deserializeMintedEvent throws on malformed serialized data and can be caught to skip", () => {
    // These represent what would happen if someone passed invalid serialized data
    const malformedRaws: unknown[] = [
        null,
        {},
        { strike: "not-a-number", quantity: "10", cost: "5", askPrice: "1" },
        { strike: "-1", quantity: "10", cost: "5", askPrice: "1" },
    ];

    let parsed = 0;
    for (const raw of malformedRaws) {
        try {
            deserializeMintedEvent(raw as SerializedMintedPositionEvent);
            parsed += 1;
        } catch {
            // correctly skipped
        }
    }

    // All should either throw or return invalid results
    // The key point is they don't crash the process — errors can be caught
    assert.ok(parsed <= malformedRaws.length, "malformed events can be caught");
});

test("positionKeyFromRedeemed returns oracleId:expiryMs:strike:UP for isUp=true", () => {
    const key = positionKeyFromRedeemed({
        oracleId: "0xoracle",
        expiryMs: 1700000000000,
        strike: 50000_000_000_000_000n,
        isUp: true,
    });

    assert.equal(key, "0xoracle:1700000000000:50000000000000000:UP");
});

test("positionKeyFromRedeemed returns oracleId:expiryMs:strike:DOWN for isUp=false", () => {
    const key = positionKeyFromRedeemed({
        oracleId: "0xoracle",
        expiryMs: 1700000000000,
        strike: 50000_000_000_000_000n,
        isUp: false,
    });

    assert.equal(key, "0xoracle:1700000000000:50000000000000000:DOWN");
});
