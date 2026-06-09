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
    for (const key of ["message", "reason", "shortMessage", "details", "description", "stack"]) {
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

function collectNestedStrings(value: unknown, seen = new Set<unknown>()): string[] {
    if (typeof value === "string" && value.length > 0) {
        return [value];
    }
    if (value instanceof Error) {
        return [value.name, value.message, value.stack ?? ""].filter((item) => item.length > 0);
    }
    if (!isRecord(value) || seen.has(value)) {
        return [];
    }

    seen.add(value);
    const values: string[] = [];
    for (const [key, nested] of Object.entries(value)) {
        if (typeof nested === "string" && nested.length > 0) {
            values.push(key, nested);
            continue;
        }
        if (typeof nested === "number" && Number.isFinite(nested)) {
            values.push(key, nested.toString());
            continue;
        }
        values.push(...collectNestedStrings(nested, seen));
    }
    return values;
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
    const searchable = [message, code, ...collectNestedStrings(caught)].join(" ").toLowerCase();

    return (
        code === "4001" ||
        code.includes("reject") ||
        code.includes("cancel") ||
        code.includes("denied") ||
        searchable.includes("reject") ||
        searchable.includes("rejected") ||
        searchable.includes("user rejection") ||
        searchable.includes("cancel") ||
        searchable.includes("cancelled") ||
        searchable.includes("canceled") ||
        searchable.includes("user denied") ||
        searchable.includes("denied by user") ||
        (searchable.includes("mutation") &&
            (searchable.includes("signandexecutetransactionblock") ||
                searchable.includes("signandexecutetransaction")) &&
            !searchable.includes("digest") &&
            !searchable.includes("moveabort"))
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
