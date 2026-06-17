export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    concurrency: number,
    task: (item: T) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex;
                nextIndex += 1;
                results[index] = await task(items[index] as T);
            }
        }),
    );
    return results;
}
