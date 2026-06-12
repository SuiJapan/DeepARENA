import assert from "node:assert/strict";
import test from "node:test";
import { buildBinaryPreviewCacheKey, buildBinaryPreviewRequestKey } from "./preview-key.ts";

test("builds binary preview cache key without oracle timestamp", () => {
    const first = buildBinaryPreviewCacheKey({
        oracleId: "0xoracle",
        expiryMs: "1790000000000",
        referenceStrikeRaw: "4200000000000",
        betAmountAtomic: "10000000",
    });
    const second = buildBinaryPreviewCacheKey({
        oracleId: "0xoracle",
        expiryMs: "1790000000000",
        referenceStrikeRaw: "4200000000000",
        betAmountAtomic: "10000000",
    });

    assert.equal(first, "0xoracle:1790000000000:4200000000000:10000000");
    assert.equal(second, first);
});

test("includes wallet address only in client request de-duplication key", () => {
    const common = {
        oracleId: "0xoracle",
        expiryMs: 1790000000000,
        referenceStrikeRaw: 4200000000000n,
        betAmountAtomic: 10000000n,
    };

    assert.equal(
        buildBinaryPreviewRequestKey({ walletAddress: "0xalice", ...common }),
        "0xalice:0xoracle:1790000000000:4200000000000:10000000",
    );
    assert.notEqual(
        buildBinaryPreviewRequestKey({ walletAddress: "0xalice", ...common }),
        buildBinaryPreviewRequestKey({ walletAddress: "0xbob", ...common }),
    );
});
