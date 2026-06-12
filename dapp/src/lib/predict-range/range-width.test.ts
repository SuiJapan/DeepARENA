import assert from "node:assert/strict";
import test from "node:test";
import { rangeProbabilityBps, selectRangeWidthQuote } from "./range-width.ts";

test("calculates range probability from mint cost divided by quantity", () => {
    assert.equal(rangeProbabilityBps({ quantity: 100n, mintCost: 64n }), 6_400n);
});

test("selects the width whose probability is closest to 50 percent", () => {
    const selected = selectRangeWidthQuote([
        { widthTicks: 500n, quantity: 100n, mintCost: 100n },
        { widthTicks: 200n, quantity: 100n, mintCost: 93n },
        { widthTicks: 100n, quantity: 100n, mintCost: 64n },
        { widthTicks: 50n, quantity: 100n, mintCost: 36n },
        { widthTicks: 20n, quantity: 100n, mintCost: 15n },
    ]);

    assert.deepEqual(selected, {
        widthTicks: 100n,
        probabilityBps: 6_400n,
        inTargetBand: false,
    });
});

test("prefers the wider width when two quotes are equally close to target", () => {
    const selected = selectRangeWidthQuote([
        { widthTicks: 50n, quantity: 100n, mintCost: 40n },
        { widthTicks: 100n, quantity: 100n, mintCost: 60n },
    ]);

    assert.equal(selected?.widthTicks, 100n);
    assert.equal(selected?.inTargetBand, true);
});

test("returns null when no range width quote is available", () => {
    assert.equal(selectRangeWidthQuote([]), null);
});
