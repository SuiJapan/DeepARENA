function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Invalid ${field}: expected non-empty string`);
    }
    return value;
}

export function readDynamicFieldNameAddress(value: unknown, field: string): string {
    if (typeof value === "string") {
        return readString(value, field);
    }
    if (isRecord(value)) {
        if (typeof value.value === "string") {
            return readString(value.value, `${field}.value`);
        }
        if (isRecord(value.fields) && typeof value.fields.value === "string") {
            return readString(value.fields.value, `${field}.fields.value`);
        }
        if (typeof value.Address === "string") {
            return readString(value.Address, `${field}.Address`);
        }
    }
    throw new Error(`Invalid ${field}: expected dynamic field address name`);
}
