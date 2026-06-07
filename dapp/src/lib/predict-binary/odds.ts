export function formatBinaryOddsFromQuantity(quantity: bigint, cost: bigint): string {
    if (quantity <= 0n || cost <= 0n) {
        return "--";
    }
    const scaled = (quantity * 10_000n) / cost;
    const rounded = (scaled + 50n) / 100n;
    const whole = rounded / 100n;
    const fractional = rounded % 100n;
    return `${whole.toString()}.${fractional.toString().padStart(2, "0")}x`;
}
