import { type NextRequest, NextResponse } from "next/server";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
    queryWalletPositionMintedEvents,
    queryWalletRangeMintedEvents,
    queryManagerPositionRedeemedEvents,
    readManagerBalance,
    type MintedPositionEvent,
    type RangeMintEvent,
    type RedeemedPositionEvent,
} from "@/src/lib/predict-binary/client";
import { PREDICT_BINARY_CONFIG } from "@/src/lib/predict-binary/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MINTED_EVENT_MAX_PAGES = 40;
const REDEEMED_EVENT_MAX_PAGES = 40;
const EVENT_PAGE_SIZE = 50;
const CLAIM_CHECK_CONCURRENCY = 5;

const suiClient = new SuiJsonRpcClient({
    network: PREDICT_BINARY_CONFIG.network,
    url: PREDICT_BINARY_CONFIG.fullnodeJsonRpcUrl,
});

// --- BigInt serialization helpers ---

type Serialized<T> = T extends bigint
    ? string
    : T extends Array<infer U>
      ? Array<Serialized<U>>
      : T extends object
        ? { [K in keyof T]: Serialized<T[K]> }
        : T;

function serializeBigInts<T>(value: T): Serialized<T> {
    if (typeof value === "bigint") {
        return value.toString() as Serialized<T>;
    }
    if (Array.isArray(value)) {
        return value.map(serializeBigInts) as Serialized<T>;
    }
    if (value !== null && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            result[k] = serializeBigInts(v);
        }
        return result as Serialized<T>;
    }
    return value as Serialized<T>;
}

// --- Claim check helpers ---

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOwnerAddress(value: unknown): string | null {
    if (typeof value === "string") {
        return value;
    }
    if (!isRecord(value)) {
        return null;
    }
    const addressOwner = value.AddressOwner;
    return typeof addressOwner === "string" ? addressOwner : null;
}

function hasPositiveWalletDusdcBalanceChange(
    balanceChanges: unknown,
    walletAddress: string,
): boolean {
    if (!Array.isArray(balanceChanges)) {
        return false;
    }
    return balanceChanges.some((change) => {
        if (!isRecord(change)) {
            return false;
        }
        const owner = readOwnerAddress(change.owner);
        const coinType = typeof change.coinType === "string" ? change.coinType : null;
        const amount = typeof change.amount === "string" ? change.amount : null;
        return (
            owner?.toLowerCase() === walletAddress.toLowerCase() &&
            coinType === PREDICT_BINARY_CONFIG.quoteCoinType &&
            amount !== null &&
            BigInt(amount) > 0n
        );
    });
}

function isSuccessfulTransactionResult(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    const directEffects = isRecord(value.effects) ? value.effects : null;
    const transaction = isRecord(value.Transaction) ? value.Transaction : null;
    const transactionEffects =
        transaction && isRecord(transaction.effects) ? transaction.effects : null;
    const status =
        (isRecord(transactionEffects?.status) ? transactionEffects.status.status : null) ??
        (isRecord(directEffects?.status) ? directEffects.status.status : null);
    return status === "success";
}

async function checkHasWalletDusdcClaim(
    digest: string,
    walletAddress: string,
): Promise<boolean> {
    try {
        const response = await fetch(PREDICT_BINARY_CONFIG.fullnodeJsonRpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: digest,
                method: "sui_getTransactionBlock",
                params: [digest, { showBalanceChanges: true, showEffects: true }],
            }),
        });
        if (!response.ok) {
            return false;
        }
        const payload = await response.json();
        const result = isRecord(payload) ? payload.result : null;
        const balanceChanges = isRecord(payload) && isRecord(payload.result)
            ? payload.result.balanceChanges ?? null
            : null;
        return (
            isSuccessfulTransactionResult(result) &&
            hasPositiveWalletDusdcBalanceChange(balanceChanges, walletAddress)
        );
    } catch {
        return false;
    }
}

async function mapWithConcurrency<T, R>(
    items: readonly T[],
    concurrency: number,
    task: (item: T) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex;
                nextIndex += 1;
                results[index] = await task(items[index] as T);
            }
        }),
    );
    return results;
}

// --- Route handler ---

export async function GET(request: NextRequest): Promise<NextResponse> {
    const wallet = request.nextUrl.searchParams.get("wallet");
    if (!wallet || !/^0x[0-9a-fA-F]{1,64}$/.test(wallet)) {
        return NextResponse.json(
            { error: "wallet parameter is required and must be a valid Sui address" },
            { status: 400 },
        );
    }

    try {
        const [mintedResult, rangeMintedResult] = await Promise.all([
            queryWalletPositionMintedEvents({
                trader: wallet,
                predictId: PREDICT_BINARY_CONFIG.predictObjectId,
                quoteCoinType: PREDICT_BINARY_CONFIG.quoteCoinType,
                maxPages: MINTED_EVENT_MAX_PAGES,
                pageSize: EVENT_PAGE_SIZE,
            }),
            queryWalletRangeMintedEvents({
                trader: wallet,
                predictId: PREDICT_BINARY_CONFIG.predictObjectId,
                quoteCoinType: PREDICT_BINARY_CONFIG.quoteCoinType,
                maxPages: MINTED_EVENT_MAX_PAGES,
                pageSize: EVENT_PAGE_SIZE,
            }),
        ]);

        const managerIds = [...new Set(mintedResult.events.map((e) => e.managerId))];

        const redeemedResults = await Promise.all(
            managerIds.map((managerId) =>
                queryManagerPositionRedeemedEvents({
                    managerId,
                    maxPages: REDEEMED_EVENT_MAX_PAGES,
                    pageSize: EVENT_PAGE_SIZE,
                }),
            ),
        );
        const redeemed: RedeemedPositionEvent[] = redeemedResults.flatMap((r) => r.events);

        const [claimedChecks, managerBalanceEntries] = await Promise.all([
            mapWithConcurrency(redeemed, CLAIM_CHECK_CONCURRENCY, async (event) => {
                if (!event.digest) return null;
                const hasClaim = await checkHasWalletDusdcClaim(event.digest, wallet);
                return hasClaim
                    ? [
                          event.oracleId,
                          event.expiryMs.toString(),
                          event.strike.toString(),
                          event.isUp ? "UP" : "DOWN",
                      ].join(":")
                    : null;
            }),
            Promise.all(
                managerIds.map(async (managerId) => {
                    try {
                        const balance = await readManagerBalance(suiClient, wallet, managerId);
                        return [managerId, balance.toString()] as const;
                    } catch {
                        return null;
                    }
                }),
            ),
        ]);

        const claimedKeys = claimedChecks.filter((key): key is string => key !== null);
        const managerBalances = Object.fromEntries(
            managerBalanceEntries.filter((e): e is [string, string] => e !== null),
        );

        return NextResponse.json({
            minted: serializeBigInts(mintedResult.events),
            rangeMinted: serializeBigInts(rangeMintedResult.events),
            redeemed: serializeBigInts(redeemed),
            claimedKeys,
            managerBalances,
            pagesInfo: {
                mintedPagesRead: mintedResult.pagesRead,
                mintedReachedLimit: mintedResult.reachedLimit,
                rangePagesRead: rangeMintedResult.pagesRead,
                rangeReachedLimit: rangeMintedResult.reachedLimit,
                redeemedPagesRead: redeemedResults.reduce((acc, r) => acc + r.pagesRead, 0),
                redeemedReachedLimit: redeemedResults.some((r) => r.reachedLimit),
            },
        });
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
