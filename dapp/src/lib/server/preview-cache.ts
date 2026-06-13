export const PREVIEW_CACHE_FRESH_MS = 15_000;
export const PREVIEW_CACHE_STALE_MS = 60_000;
export const PREVIEW_CACHE_MAX_ENTRIES = 500;

type PreviewCacheState = "fresh" | "stale" | "miss";

interface PreviewCacheEntry<T> {
    value: T;
    createdAtMs: number;
    freshUntilMs: number;
    staleUntilMs: number;
}

export interface PreviewCacheResult<T> {
    value: T;
    state: PreviewCacheState;
}

export interface PreviewCache<T> {
    getOrLoad(
        key: string,
        load: () => Promise<T>,
        options?: { shouldCache?: (value: T) => boolean },
    ): Promise<PreviewCacheResult<T>>;
    warm(
        key: string,
        load: () => Promise<T>,
        options?: { shouldCache?: (value: T) => boolean },
    ): void;
    size(): number;
}

class InMemoryPreviewCache<T> implements PreviewCache<T> {
    private readonly entries = new Map<string, PreviewCacheEntry<T>>();
    private readonly inFlightLoads = new Set<string>();
    private readonly nowMs: () => number;

    constructor(nowMs: () => number = Date.now) {
        this.nowMs = nowMs;
    }

    async getOrLoad(
        key: string,
        load: () => Promise<T>,
        options: { shouldCache?: (value: T) => boolean } = {},
    ): Promise<PreviewCacheResult<T>> {
        const nowMs = this.nowMs();
        const entry = this.entries.get(key);
        if (entry && entry.freshUntilMs > nowMs) {
            return { value: entry.value, state: "fresh" };
        }
        if (entry && entry.staleUntilMs > nowMs) {
            this.warm(key, load, options);
            return { value: entry.value, state: "stale" };
        }
        const value = await this.loadAndMaybeStore(key, load, options.shouldCache);
        return { value, state: "miss" };
    }

    warm(
        key: string,
        load: () => Promise<T>,
        options: { shouldCache?: (value: T) => boolean } = {},
    ): void {
        if (this.inFlightLoads.has(key)) {
            return;
        }
        this.inFlightLoads.add(key);
        void this.loadAndMaybeStore(key, load, options.shouldCache)
            .catch((caught) => {
                console.warn("Preview cache warm-up failed", {
                    key,
                    reason: caught instanceof Error ? caught.message : String(caught),
                });
            })
            .finally(() => {
                this.inFlightLoads.delete(key);
            });
    }

    size(): number {
        return this.entries.size;
    }

    private async loadAndMaybeStore(
        key: string,
        load: () => Promise<T>,
        shouldCache: ((value: T) => boolean) | undefined,
    ): Promise<T> {
        const value = await load();
        if (shouldCache?.(value) ?? true) {
            this.store(key, value);
        }
        return value;
    }

    private store(key: string, value: T): void {
        if (this.entries.has(key)) {
            this.entries.delete(key);
        }
        const createdAtMs = this.nowMs();
        this.entries.set(key, {
            value,
            createdAtMs,
            freshUntilMs: createdAtMs + PREVIEW_CACHE_FRESH_MS,
            staleUntilMs: createdAtMs + PREVIEW_CACHE_STALE_MS,
        });
        while (this.entries.size > PREVIEW_CACHE_MAX_ENTRIES) {
            const oldestKey = this.entries.keys().next().value;
            if (typeof oldestKey !== "string") {
                return;
            }
            this.entries.delete(oldestKey);
        }
    }
}

const previewCacheSymbol = Symbol.for("deeparena.previewCacheByNamespace");

function readGlobalPreviewCaches(): Map<string, InMemoryPreviewCache<unknown>> {
    const globalWithCache = globalThis as typeof globalThis & {
        [previewCacheSymbol]?: Map<string, InMemoryPreviewCache<unknown>>;
    };
    if (!globalWithCache[previewCacheSymbol]) {
        globalWithCache[previewCacheSymbol] = new Map();
    }
    return globalWithCache[previewCacheSymbol];
}

export function getSharedPreviewCache<T>(namespace: string): PreviewCache<T> {
    const caches = readGlobalPreviewCaches();
    const existing = caches.get(namespace);
    if (existing) {
        return existing as InMemoryPreviewCache<T>;
    }
    const cache = new InMemoryPreviewCache<T>();
    caches.set(namespace, cache as InMemoryPreviewCache<unknown>);
    return cache;
}

export function createPreviewCache<T>(nowMs: () => number = Date.now): PreviewCache<T> {
    return new InMemoryPreviewCache<T>(nowMs);
}
