import { bcs } from "@mysten/sui/bcs";
import type { TradeAmounts } from "./preview.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCommandResults(result: unknown): unknown[] {
    if (!isRecord(result) || !Array.isArray(result.commandResults)) {
        return [];
    }
    return result.commandResults;
}

function readCommandReturnValues(command: unknown): unknown[] {
    if (!isRecord(command) || !Array.isArray(command.returnValues)) {
        return [];
    }
    return command.returnValues;
}

function decodeU64ReturnValue(value: unknown): bigint {
    if (!isRecord(value) || !(value.bcs instanceof Uint8Array)) {
        throw new Error("Invalid u64 return value");
    }
    return BigInt(bcs.U64.parse(value.bcs));
}

function decodeU64PairReturnValue(value: unknown): [bigint, bigint] | null {
    if (!isRecord(value) || !(value.bcs instanceof Uint8Array) || value.bcs.length !== 16) {
        return null;
    }
    const view = new DataView(value.bcs.buffer, value.bcs.byteOffset, value.bcs.byteLength);
    return [view.getBigUint64(0, true), view.getBigUint64(8, true)];
}

function decodeTradeAmountReturnValues(returnValues: unknown[]): TradeAmounts | null {
    if (returnValues.length < 2) {
        const tupleValues =
            returnValues.length === 1 ? decodeU64PairReturnValue(returnValues[0]) : null;
        if (!tupleValues) {
            return null;
        }
        const [mintCost, redeemPayout] = tupleValues;
        return { mintCost, redeemPayout };
    }
    const [mintCostValue, redeemPayoutValue] = returnValues;
    if (!mintCostValue || !redeemPayoutValue) {
        return null;
    }
    return {
        mintCost: decodeU64ReturnValue(mintCostValue),
        redeemPayout: decodeU64ReturnValue(redeemPayoutValue),
    };
}

export function decodeAllTradeAmountReturns(result: unknown): TradeAmounts[] {
    if (isRecord(result) && result.$kind === "FailedTransaction") {
        throw new Error("Simulation failed");
    }
    return readCommandResults(result).flatMap((command) => {
        const decoded = decodeTradeAmountReturnValues(readCommandReturnValues(command));
        return decoded ? [decoded] : [];
    });
}
