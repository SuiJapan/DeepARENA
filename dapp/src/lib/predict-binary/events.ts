function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readSuiEventPayload(event: unknown): Record<string, unknown> | null {
    const payloads = readSuiEventPayloads(event);
    return payloads.parsedJson ?? payloads.json;
}

export function readSuiEventPayloads(event: unknown): {
    parsedJson: Record<string, unknown> | null;
    json: Record<string, unknown> | null;
} {
    if (!isRecord(event)) {
        return { parsedJson: null, json: null };
    }
    return {
        parsedJson: isRecord(event.parsedJson) ? event.parsedJson : null,
        json: isRecord(event.json) ? event.json : null,
    };
}
