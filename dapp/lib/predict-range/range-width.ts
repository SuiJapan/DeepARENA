export const RANGE_WIDTH_CANDIDATES_TICKS = [500n, 200n, 100n, 50n, 20n] as const;
export const RANGE_TARGET_PROBABILITY_BPS = 5_000n;
export const RANGE_TARGET_MIN_PROBABILITY_BPS = 4_000n;
export const RANGE_TARGET_MAX_PROBABILITY_BPS = 6_000n;

export interface RangeWidthQuote {
    widthTicks: bigint;
    quantity: bigint;
    mintCost: bigint;
}

export interface RangeWidthSelection {
    widthTicks: bigint;
    probabilityBps: bigint;
    inTargetBand: boolean;
}

function distanceFromTarget(probabilityBps: bigint): bigint {
    return probabilityBps > RANGE_TARGET_PROBABILITY_BPS
        ? probabilityBps - RANGE_TARGET_PROBABILITY_BPS
        : RANGE_TARGET_PROBABILITY_BPS - probabilityBps;
}

export function rangeProbabilityBps({
    quantity,
    mintCost,
}: Pick<RangeWidthQuote, "quantity" | "mintCost">): bigint {
    if (quantity <= 0n || mintCost <= 0n) {
        throw new Error("Invalid range width quote");
    }
    return (mintCost * 10_000n) / quantity;
}

export function selectRangeWidthQuote(quotes: RangeWidthQuote[]): RangeWidthSelection | null {
    let selected: RangeWidthSelection | null = null;
    for (const quote of quotes) {
        const probabilityBps = rangeProbabilityBps(quote);
        const candidate = {
            widthTicks: quote.widthTicks,
            probabilityBps,
            inTargetBand:
                probabilityBps >= RANGE_TARGET_MIN_PROBABILITY_BPS &&
                probabilityBps <= RANGE_TARGET_MAX_PROBABILITY_BPS,
        };
        if (!selected) {
            selected = candidate;
            continue;
        }
        const candidateDistance = distanceFromTarget(candidate.probabilityBps);
        const selectedDistance = distanceFromTarget(selected.probabilityBps);
        if (
            candidateDistance < selectedDistance ||
            (candidateDistance === selectedDistance && candidate.widthTicks > selected.widthTicks)
        ) {
            selected = candidate;
        }
    }
    return selected;
}
