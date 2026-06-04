import type { ActionKind, ActionPreview, EventLog, TokenAmount } from "./types";

const amountPattern = /^\d+$/;
const decimalPattern = /^\d+(\.\d+)?$/;

export function normalizeAtomicAmount(
    atomic: string,
    decimals: number,
    symbol: string,
): TokenAmount {
    if (!amountPattern.test(atomic) || !Number.isInteger(decimals) || decimals < 0 || !symbol) {
        throw new Error("Invalid token amount");
    }

    return { atomic, decimals, symbol };
}

export function normalizeQuantity(quantity: string): string {
    const value = quantity.trim();
    if (!decimalPattern.test(value) || Number(value) <= 0) {
        throw new Error("Quantity must be a positive decimal value");
    }
    return value;
}

export function normalizeActionPreview(input: {
    kind: ActionKind;
    marketId: string;
    marketLabel: string;
    quantity: string;
    estimatedCostAtomic: string;
    estimatedPayoutAtomic: string;
    feeAtomic: string;
    decimals: number;
    symbol: string;
}): ActionPreview {
    return {
        kind: input.kind,
        marketId: input.marketId,
        marketLabel: input.marketLabel,
        quantity: normalizeQuantity(input.quantity),
        estimatedCost: normalizeAtomicAmount(
            input.estimatedCostAtomic,
            input.decimals,
            input.symbol,
        ),
        estimatedPayout: normalizeAtomicAmount(
            input.estimatedPayoutAtomic,
            input.decimals,
            input.symbol,
        ),
        fee: normalizeAtomicAmount(input.feeAtomic, input.decimals, input.symbol),
        warning: "Mock preview only. No wallet signature or onchain transaction will be created.",
    };
}

export function normalizeEventLog(event: EventLog): EventLog {
    if (!event.id || !event.title || !event.actor || !Number.isFinite(event.timestampMs)) {
        throw new Error("Invalid event log");
    }
    return { ...event };
}
