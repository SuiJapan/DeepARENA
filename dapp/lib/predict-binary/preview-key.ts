export interface BinaryPreviewCacheKeyInput {
    oracleId: string;
    expiryMs: string | number | bigint;
    referenceStrikeRaw: string | number | bigint;
    betAmountAtomic: string | number | bigint;
}

export interface BinaryPreviewRequestKeyInput extends BinaryPreviewCacheKeyInput {
    walletAddress: string;
}

export function buildBinaryPreviewCacheKey(input: BinaryPreviewCacheKeyInput): string {
    return [
        input.oracleId,
        input.expiryMs.toString(),
        input.referenceStrikeRaw.toString(),
        input.betAmountAtomic.toString(),
    ].join(":");
}

export function buildBinaryPreviewRequestKey(input: BinaryPreviewRequestKeyInput): string {
    return [input.walletAddress, buildBinaryPreviewCacheKey(input)].join(":");
}
