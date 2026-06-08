function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNestedString(value: unknown, seen: Set<unknown>): string | null {
    if (typeof value === "string" && value.length > 0) {
        return value;
    }
    if (value instanceof Error && value.message.length > 0) {
        return value.message;
    }
    if (!isRecord(value) || seen.has(value)) {
        return null;
    }

    seen.add(value);
    for (const key of ["message", "reason", "shortMessage", "details", "description"]) {
        const candidate = value[key];
        if (typeof candidate === "string" && candidate.length > 0) {
            return candidate;
        }
    }

    for (const key of ["cause", "error", "data"]) {
        const nested = readNestedString(value[key], seen);
        if (nested !== null) {
            return nested;
        }
    }

    return null;
}

export function readWalletErrorMessage(caught: unknown): string {
    return readNestedString(caught, new Set()) ?? String(caught);
}

export function readWalletErrorCode(caught: unknown): string | null {
    if (!isRecord(caught)) {
        return null;
    }

    const candidates = [caught.code, caught.errorCode, caught.status, caught.name];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.length > 0) {
            return candidate;
        }
        if (typeof candidate === "number" && Number.isFinite(candidate)) {
            return candidate.toString();
        }
    }

    if (isRecord(caught.cause)) {
        return readWalletErrorCode(caught.cause);
    }
    if (isRecord(caught.error)) {
        return readWalletErrorCode(caught.error);
    }
    if (isRecord(caught.data)) {
        return readWalletErrorCode(caught.data);
    }

    return null;
}

export function isWalletUserRejection(caught: unknown): boolean {
    const message = readWalletErrorMessage(caught).toLowerCase();
    const code = readWalletErrorCode(caught)?.toLowerCase() ?? "";

    return (
        code === "4001" ||
        code.includes("reject") ||
        code.includes("cancel") ||
        code.includes("denied") ||
        message.includes("reject") ||
        message.includes("rejected") ||
        message.includes("user rejection") ||
        message.includes("cancel") ||
        message.includes("cancelled") ||
        message.includes("canceled") ||
        message.includes("user denied") ||
        message.includes("denied by user")
    );
}

export function readWalletCancellationDebug(caught: unknown): {
    reason: string;
    code: string | null;
} {
    return {
        reason: readWalletErrorMessage(caught),
        code: readWalletErrorCode(caught),
    };
}
