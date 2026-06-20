import assert from "node:assert/strict";
import test from "node:test";
import { readDynamicFieldNameAddress } from "./dynamic-field.ts";

test("reads dynamic field address name from a plain string", () => {
    assert.equal(readDynamicFieldNameAddress("0xabc", "player.address"), "0xabc");
});

test("reads dynamic field address name from Sui name value records", () => {
    assert.equal(
        readDynamicFieldNameAddress({ type: "address", value: "0x123" }, "player.address"),
        "0x123",
    );
});

test("reads dynamic field address name from nested field records", () => {
    assert.equal(
        readDynamicFieldNameAddress(
            { fields: { type: "address", value: "0x456" } },
            "player.address",
        ),
        "0x456",
    );
});

test("rejects malformed dynamic field address names", () => {
    assert.throws(
        () => readDynamicFieldNameAddress({ type: "address" }, "player.address"),
        /Invalid player\.address/,
    );
});
