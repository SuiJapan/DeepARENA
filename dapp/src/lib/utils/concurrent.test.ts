import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "./concurrent.ts";

test("returns results in input order when processed with concurrency=2", async () => {
    const items = [1, 2, 3];
    const results = await mapWithConcurrency(items, async (x) => x * 10, 2);
    assert.deepEqual(results, [10, 20, 30]);
});

test("does not exceed concurrency=1 (sequential processing)", async () => {
    const inFlight: number[] = [];
    let maxInFlight = 0;

    await mapWithConcurrency(
        [1, 2, 3, 4],
        async (x) => {
            inFlight.push(x);
            maxInFlight = Math.max(maxInFlight, inFlight.length);
            await Promise.resolve();
            inFlight.pop();
            return x;
        },
        1,
    );

    assert.equal(maxInFlight, 1);
});

test("returns empty array for empty input", async () => {
    const results = await mapWithConcurrency([], async (x: number) => x, 2);
    assert.deepEqual(results, []);
});

test("rejects when any item rejects", async () => {
    await assert.rejects(
        mapWithConcurrency(
            [1, 2, 3],
            async (x) => {
                if (x === 2) throw new Error("item 2 failed");
                return x;
            },
            2,
        ),
        /item 2 failed/,
    );
});
