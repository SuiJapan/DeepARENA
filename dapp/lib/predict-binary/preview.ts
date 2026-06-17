export interface TradeAmounts {
    mintCost: bigint;
    redeemPayout: bigint;
}

export interface BudgetedTradePreview extends TradeAmounts {
    quantity: bigint;
    firstTriedQuantity: bigint;
    debug?: unknown;
}

export interface NoMintableQuantityContext {
    firstTriedQuantity: bigint;
    lastTriedQuantity: bigint | null;
    attempts: number;
}

export async function findBudgetedTradePreview({
    budget,
    preview,
    createNoMintableQuantityError,
}: {
    budget: bigint;
    preview: (quantity: bigint) => Promise<TradeAmounts>;
    createNoMintableQuantityError?: (context: NoMintableQuantityContext) => Error;
}): Promise<BudgetedTradePreview> {
    const firstTriedQuantity = 1n;
    let affordableQuantity = 0n;
    let affordablePreview: TradeAmounts | null = null;
    let probeQuantity = firstTriedQuantity;
    let lastTriedQuantity: bigint | null = null;
    let attempts = 0;

    for (let probeAttempts = 0; probeAttempts < 96; probeAttempts += 1) {
        lastTriedQuantity = probeQuantity;
        attempts += 1;
        const result = await preview(probeQuantity);
        if (result.mintCost > budget) {
            break;
        }
        if (result.mintCost > 0n) {
            affordableQuantity = probeQuantity;
            affordablePreview = result;
        }
        probeQuantity *= 2n;
    }

    if (!affordablePreview || affordableQuantity <= 0n) {
        if (createNoMintableQuantityError) {
            throw createNoMintableQuantityError({
                firstTriedQuantity,
                lastTriedQuantity,
                attempts,
            });
        }
        throw new Error("Amount is too small for a mintable quantity");
    }

    let low = affordableQuantity + 1n;
    let high = probeQuantity - 1n;
    let best: BudgetedTradePreview = {
        quantity: affordableQuantity,
        firstTriedQuantity,
        ...affordablePreview,
    };

    while (low <= high) {
        const quantity = (low + high) / 2n;
        const result = await preview(quantity);
        if (result.mintCost > 0n && result.mintCost <= budget) {
            best = { quantity, firstTriedQuantity, ...result };
            low = quantity + 1n;
        } else {
            high = quantity - 1n;
        }
    }

    return best;
}
