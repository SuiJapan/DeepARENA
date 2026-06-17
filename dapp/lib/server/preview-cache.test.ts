import assert from "node:assert/strict";
import test from "node:test";
import {
    createPreviewCache,
    PREVIEW_CACHE_FRESH_MS,
    PREVIEW_CACHE_MAX_ENTRIES,
    PREVIEW_CACHE_STALE_MS,
} from "./preview-cache.ts";

test("returns fresh preview cache entries for 15 seconds", async () => {
    let nowMs = 1_000;
    let loads = 0;
    const cache = createPreviewCache<string>(() => nowMs);

    assert.deepEqual(
        await cache.getOrLoad("preview", async () => {
            loads += 1;
            return "first";
        }),
        { value: "first", state: "miss" },
    );

    nowMs += PREVIEW_CACHE_FRESH_MS - 1;
    assert.deepEqual(
        await cache.getOrLoad("preview", async () => {
            loads += 1;
            return "second";
        }),
        { value: "first", state: "fresh" },
    );
    assert.equal(loads, 1);
});

test("returns stale preview cache entries until 60 seconds and refreshes in background", async () => {
    let nowMs = 1_000;
    let loads = 0;
    const cache = createPreviewCache<string>(() => nowMs);

    await cache.getOrLoad("preview", async () => {
        loads += 1;
        return "first";
    });
    nowMs += PREVIEW_CACHE_FRESH_MS + 1;

    assert.deepEqual(
        await cache.getOrLoad("preview", async () => {
            loads += 1;
            return "second";
        }),
        { value: "first", state: "stale" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(loads, 2);
});

test("reloads preview cache entries after 60 seconds", async () => {
    let nowMs = 1_000;
    const cache = createPreviewCache<string>(() => nowMs);

    await cache.getOrLoad("preview", async () => "first");
    nowMs += PREVIEW_CACHE_STALE_MS + 1;

    assert.deepEqual(await cache.getOrLoad("preview", async () => "second"), {
        value: "second",
        state: "miss",
    });
});

test("keeps preview cache size at 500 entries", async () => {
    const cache = createPreviewCache<string>(() => 1_000);

    for (let index = 0; index < PREVIEW_CACHE_MAX_ENTRIES + 1; index += 1) {
        await cache.getOrLoad(`preview:${index}`, async () => String(index));
    }

    assert.equal(cache.size(), PREVIEW_CACHE_MAX_ENTRIES);
    assert.deepEqual(await cache.getOrLoad("preview:0", async () => "reloaded"), {
        value: "reloaded",
        state: "miss",
    });
});
