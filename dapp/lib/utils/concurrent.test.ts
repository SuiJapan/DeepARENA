import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "./concurrent.ts";

test("returns results in input order", async () => {
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 3, async (n) => n * 10);
    assert.deepEqual(results, [10, 20, 30, 40, 50]);
});

test("concurrency=1 processes items sequentially", async () => {
    const order: number[] = [];
    await mapWithConcurrency([1, 2, 3], 1, async (n) => {
        order.push(n);
        return n;
    });
    assert.deepEqual(order, [1, 2, 3]);
});

test("does not exceed concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const concurrency = 2;

    await mapWithConcurrency([1, 2, 3, 4, 5], concurrency, async (n) => {
        active++;
        if (active > maxActive) maxActive = active;
        await Promise.resolve();
        active--;
        return n;
    });

    assert.ok(
        maxActive <= concurrency,
        `maxActive=${maxActive} exceeded concurrency=${concurrency}`,
    );
});

test("returns empty array for empty input", async () => {
    const results = await mapWithConcurrency([], 3, async (n: number) => n);
    assert.deepEqual(results, []);
});
