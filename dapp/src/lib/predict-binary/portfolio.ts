import type { MintedPositionEvent, RangeMintEvent, RedeemedPositionEvent } from "./client";

export interface SerializedMintedPositionEvent {
    predictId: string;
    managerId: string;
    trader: string;
    quoteAssetName: string;
    oracleId: string;
    expiryMs: number;
    strike: string;
    isUp: boolean;
    quantity: string;
    cost: string;
    askPrice: string;
    digest: string | null;
    timestampMs: number | null;
}

export interface SerializedRangeMintEvent {
    predictId: string;
    managerId: string;
    trader: string;
    quoteAssetName: string;
    oracleId: string;
    expiryMs: number;
    lowerStrike: string;
    higherStrike: string;
    quantity: string;
    cost: string;
    askPrice: string;
    digest: string | null;
    timestampMs: number | null;
}

export interface SerializedRedeemedPositionEvent {
    managerId: string;
    oracleId: string;
    expiryMs: number;
    strike: string;
    isUp: boolean;
    quantity: string;
    payout: string;
    bidPrice: string;
    isSettled: boolean;
    digest: string | null;
    timestampMs: number | null;
}

export function serializeMintedEvent(event: MintedPositionEvent): SerializedMintedPositionEvent {
    return {
        predictId: event.predictId,
        managerId: event.managerId,
        trader: event.trader,
        quoteAssetName: event.quoteAssetName,
        oracleId: event.oracleId,
        expiryMs: event.expiryMs,
        strike: event.strike.toString(),
        isUp: event.isUp,
        quantity: event.quantity.toString(),
        cost: event.cost.toString(),
        askPrice: event.askPrice.toString(),
        digest: event.digest,
        timestampMs: event.timestampMs,
    };
}

export function serializeRangeMintedEvent(event: RangeMintEvent): SerializedRangeMintEvent {
    return {
        predictId: event.predictId,
        managerId: event.managerId,
        trader: event.trader,
        quoteAssetName: event.quoteAssetName,
        oracleId: event.oracleId,
        expiryMs: event.expiryMs,
        lowerStrike: event.lowerStrike.toString(),
        higherStrike: event.higherStrike.toString(),
        quantity: event.quantity.toString(),
        cost: event.cost.toString(),
        askPrice: event.askPrice.toString(),
        digest: event.digest,
        timestampMs: event.timestampMs,
    };
}

export function serializeRedeemedEvent(
    event: RedeemedPositionEvent,
): SerializedRedeemedPositionEvent {
    return {
        managerId: event.managerId,
        oracleId: event.oracleId,
        expiryMs: event.expiryMs,
        strike: event.strike.toString(),
        isUp: event.isUp,
        quantity: event.quantity.toString(),
        payout: event.payout.toString(),
        bidPrice: event.bidPrice.toString(),
        isSettled: event.isSettled,
        digest: event.digest,
        timestampMs: event.timestampMs,
    };
}

export function deserializeMintedEvent(raw: SerializedMintedPositionEvent): MintedPositionEvent {
    return {
        predictId: raw.predictId,
        managerId: raw.managerId,
        trader: raw.trader,
        quoteAssetName: raw.quoteAssetName,
        oracleId: raw.oracleId,
        expiryMs: raw.expiryMs,
        strike: BigInt(raw.strike),
        isUp: raw.isUp,
        quantity: BigInt(raw.quantity),
        cost: BigInt(raw.cost),
        askPrice: BigInt(raw.askPrice),
        digest: raw.digest,
        timestampMs: raw.timestampMs,
    };
}

export function deserializeRangeMintedEvent(raw: SerializedRangeMintEvent): RangeMintEvent {
    return {
        predictId: raw.predictId,
        managerId: raw.managerId,
        trader: raw.trader,
        quoteAssetName: raw.quoteAssetName,
        oracleId: raw.oracleId,
        expiryMs: raw.expiryMs,
        lowerStrike: BigInt(raw.lowerStrike),
        higherStrike: BigInt(raw.higherStrike),
        quantity: BigInt(raw.quantity),
        cost: BigInt(raw.cost),
        askPrice: BigInt(raw.askPrice),
        digest: raw.digest,
        timestampMs: raw.timestampMs,
    };
}

export function deserializeRedeemedEvent(
    raw: SerializedRedeemedPositionEvent,
): RedeemedPositionEvent {
    return {
        managerId: raw.managerId,
        oracleId: raw.oracleId,
        expiryMs: raw.expiryMs,
        strike: BigInt(raw.strike),
        isUp: raw.isUp,
        quantity: BigInt(raw.quantity),
        payout: BigInt(raw.payout),
        bidPrice: BigInt(raw.bidPrice),
        isSettled: raw.isSettled,
        digest: raw.digest,
        timestampMs: raw.timestampMs,
    };
}

export function positionKeyFromRedeemed({
    oracleId,
    expiryMs,
    strike,
    isUp,
}: {
    oracleId: string;
    expiryMs: number;
    strike: bigint;
    isUp: boolean;
}): string {
    return [oracleId, expiryMs.toString(), strike.toString(), isUp ? "UP" : "DOWN"].join(":");
}
