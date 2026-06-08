function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readWalletErrorMessage(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
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
        message.includes("cancel") ||
        message.includes("cancelled") ||
        message.includes("canceled") ||
        message.includes("user denied")
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
