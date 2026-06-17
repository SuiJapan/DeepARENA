export interface ParsedTokenAmount {
    atomic: bigint;
    display: string;
}

export function parseTokenAmount(input: string, decimals: number): ParsedTokenAmount {
    const trimmed = input.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
        throw new Error("Amount must be a positive number");
    }

    const [whole, fractional = ""] = trimmed.split(".");
    if (fractional.length > decimals) {
        throw new Error(`Amount supports up to ${decimals} decimal places`);
    }

    const atomic =
        BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fractional.padEnd(decimals, "0"));
    if (atomic <= 0n) {
        throw new Error("Amount must be greater than zero");
    }

    return { atomic, display: trimmed };
}

export function formatTokenAmount(
    atomic: bigint,
    decimals: number,
    maximumFractionDigits = 6,
): string {
    const divisor = 10n ** BigInt(decimals);
    const whole = atomic / divisor;
    const fractional = atomic % divisor;
    if (fractional === 0n) {
        return whole.toLocaleString("en-US");
    }

    const padded = fractional.toString().padStart(decimals, "0");
    const trimmed = padded.replace(/0+$/, "").slice(0, maximumFractionDigits);
    return `${whole.toLocaleString("en-US")}.${trimmed}`;
}

export function formatTokenInputAmount(atomic: bigint, decimals: number): string {
    const divisor = 10n ** BigInt(decimals);
    const whole = atomic / divisor;
    const fractional = atomic % divisor;
    if (fractional === 0n) {
        return whole.toString();
    }

    const padded = fractional.toString().padStart(decimals, "0");
    return `${whole.toString()}.${padded.replace(/0+$/, "")}`;
}
