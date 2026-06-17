import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import type { Transaction } from "@mysten/sui/transactions";
import {
    buildPreviewCandidateQuantities,
    buildVerificationQuantities,
    selectBestBudgetedPreview,
} from "./budget-search.ts";
import { PREDICT_BINARY_CONFIG } from "./config.ts";
import { readSuiEventPayload } from "./events.ts";
import {
    type BudgetedTradePreview,
    findBudgetedTradePreview,
    type TradeAmounts,
} from "./preview.ts";
import { decodeAllTradeAmountReturns } from "./preview-decode.ts";
import {
    type BatchRangePreviewInput,
    type BinaryMarketKeyInput,
    calcMaxTotalCost,
    createBatchPreviewTransaction,
    createBatchRangePreviewTransaction,
    createMintBinaryTransaction,
    createPreviewRangeTradeAmountsTransaction,
    createPreviewTradeAmountsTransaction,
    createReadBinaryPositionTransaction,
    createReadManagerBalanceTransaction,
    type RangeKeyInput,
    target,
} from "./transactions.ts";

export interface BtcBinaryMarket {
    oracleId: string;
    expiryMs: number;
    strike: bigint;
}

export type { BudgetedTradePreview, TradeAmounts } from "./preview";
export { decodeAllTradeAmountReturns } from "./preview-decode.ts";

export interface TradePreviewDebugDetails {
    functionName: string;
    side: "UP" | "DOWN";
    walletAddress: string;
    currentOracleId: string;
    oracleExpiryMs: number;
    referenceStrikeRaw: string;
    betAmountAtomic: string;
    initialQuantity: string;
    firstPreviewCalled: boolean;
    buildTransactionCalled: boolean;
    quantityCandidate: string;
    predictObjectId: string;
    clockObjectId: string;
    quoteCoinType: string;
    moveTarget: string;
    typeArguments: string[];
    transactionInputs: {
        predictObjectId: string;
        oracleObjectId: string;
        key: {
            oracleId: string;
            expiryMs: number;
            strike: string;
            isUp: boolean;
        };
        quantity: string;
        clockObjectId: string;
    };
    devInspectSender: string;
    devInspectStatus: string;
    devInspectError: string | null;
    moveAbortCode: string | null;
    returnValuesRaw: unknown;
    firstPreviewResult?: TradeAmounts | null;
    firstPreviewError?: string | null;
    throwReason?: string | null;
    rawDevInspectResponse?: unknown;
    effectsStatus?: unknown;
    results?: unknown;
    decodedReturnValues?: string[];
    decodedMintCost?: string | null;
    decodedRedeemPayout?: string | null;
}

export class TradePreviewError extends Error {
    readonly details: TradePreviewDebugDetails;

    constructor(message: string, details: TradePreviewDebugDetails) {
        super(message);
        this.name = "TradePreviewError";
        this.details = details;
    }
}

export interface MintEvent {
    predictId: string;
    managerId: string;
    oracleId: string;
    expiryMs: number;
    strike: bigint;
    isUp: boolean;
    quantity: bigint;
    cost: bigint;
    askPrice: bigint;
}

export interface MintedPositionEvent extends MintEvent {
    trader: string;
    quoteAssetName: string;
    digest: string | null;
    timestampMs: number | null;
}

export interface RedeemEvent {
    managerId: string;
    oracleId: string;
    expiryMs: number;
    strike: bigint;
    isUp: boolean;
    quantity: bigint;
    payout: bigint;
    bidPrice: bigint;
    isSettled: boolean;
}

export interface RedeemedPositionEvent extends RedeemEvent {
    digest: string | null;
    timestampMs: number | null;
}

export interface RangeTradePreview {
    quantity: bigint;
    mintCost: bigint;
    redeemPayout: bigint;
}

export interface RangeMintEvent {
    predictId: string;
    managerId: string;
    trader: string;
    quoteAssetName: string;
    oracleId: string;
    expiryMs: number;
    lowerStrike: bigint;
    higherStrike: bigint;
    quantity: bigint;
    cost: bigint;
    askPrice: bigint;
    digest: string | null;
    timestampMs: number | null;
}

interface SimulateClient {
    core: {
        simulateTransaction<
            Include extends SuiClientTypes.SimulateTransactionInclude = Record<never, never>,
        >(
            options: SuiClientTypes.SimulateTransactionOptions<Include>,
        ): Promise<SuiClientTypes.SimulateTransactionResult<Include>>;
        getBalance(
            options: SuiClientTypes.GetBalanceOptions,
        ): Promise<SuiClientTypes.GetBalanceResponse>;
        waitForTransaction<
            Include extends SuiClientTypes.TransactionInclude = Record<never, never>,
        >(
            options: SuiClientTypes.WaitForTransactionOptions<Include>,
        ): Promise<SuiClientTypes.TransactionResult<Include>>;
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return value;
}

function readBigInt(value: unknown, fieldName: string): bigint {
    if (typeof value === "bigint") {
        return value;
    }
    const text = typeof value === "number" ? String(value) : value;
    if (typeof text !== "string" || !/^(0|[1-9]\d*)$/.test(text)) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return BigInt(text);
}

function readBoolean(value: unknown, fieldName: string): boolean {
    if (typeof value !== "boolean") {
        throw new Error(`Invalid ${fieldName}`);
    }
    return value;
}

function readOptionalString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeTypeName(value: string): string {
    return value.toLowerCase().replace(/^0x/, "");
}

function readQuoteAssetName(value: unknown): string {
    if (typeof value === "string" && value.length > 0) {
        return value;
    }
    if (!isRecord(value)) {
        throw new Error("Invalid quote_asset");
    }
    if (typeof value.name === "string" && value.name.length > 0) {
        return value.name;
    }
    if (typeof value.typeName === "string" && value.typeName.length > 0) {
        return value.typeName;
    }
    if (typeof value.type_name === "string" && value.type_name.length > 0) {
        return value.type_name;
    }
    if (typeof value.type === "string" && value.type.length > 0) {
        return value.type;
    }
    throw new Error("Invalid quote_asset");
}

function readEventDigest(event: unknown): string | null {
    if (!isRecord(event)) {
        return null;
    }
    const id = event.id;
    if (isRecord(id)) {
        return readOptionalString(id.txDigest);
    }
    return readOptionalString(event.txDigest) ?? readOptionalString(event.digest);
}

function readEventTimestampMs(event: unknown): number | null {
    if (!isRecord(event)) {
        return null;
    }
    const value = event.timestampMs;
    if (typeof value === "number" && Number.isSafeInteger(value)) {
        return value;
    }
    if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
}

function readTransactionDigest(result: unknown): string {
    if (!isRecord(result)) {
        throw new Error("Invalid transaction response");
    }
    const failed = result.FailedTransaction;
    if (isRecord(failed)) {
        throw new Error("Transaction failed");
    }
    const transaction = result.Transaction;
    if (!isRecord(transaction) || typeof transaction.digest !== "string") {
        throw new Error("Transaction digest is missing");
    }
    return transaction.digest;
}

function parseU64Return(
    result: SuiClientTypes.SimulateTransactionResult<{ commandResults: true }>,
) {
    if (result.$kind === "FailedTransaction") {
        throw new Error("Simulation failed");
    }
    const returns = result.commandResults
        .flatMap((command) => command.returnValues)
        .map((value) => BigInt(bcs.U64.parse(value.bcs)));
    if (returns.length === 0) {
        throw new Error("Simulation returned no value");
    }
    return returns;
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

function decodeTradeAmountReturnValues(
    returnValues: unknown[],
): { mintCost: bigint; redeemPayout: bigint; decodedReturnValues: bigint[] } | null {
    if (returnValues.length < 2) {
        const tupleValues =
            returnValues.length === 1 ? decodeU64PairReturnValue(returnValues[0]) : null;
        if (tupleValues) {
            const [mintCost, redeemPayout] = tupleValues;
            return { mintCost, redeemPayout, decodedReturnValues: tupleValues };
        }
        return null;
    }
    const decodedReturnValues = returnValues.slice(0, 2).map(decodeU64ReturnValue);
    const [mintCost, redeemPayout] = decodedReturnValues;
    if (mintCost === undefined || redeemPayout === undefined) {
        throw new Error("Trade preview is missing return values");
    }
    return { mintCost, redeemPayout, decodedReturnValues };
}

function decodeTradeAmountReturns(
    result: SuiClientTypes.SimulateTransactionResult<{ commandResults: true }>,
): { mintCost: bigint; redeemPayout: bigint; decodedReturnValues: bigint[] } {
    if (result.$kind === "FailedTransaction") {
        throw new Error("Simulation failed");
    }
    const commandResults = readCommandResults(result);
    const decoded = [...commandResults]
        .reverse()
        .map((command) => decodeTradeAmountReturnValues(readCommandReturnValues(command)))
        .find((value) => value !== null);
    if (!decoded) {
        throw new Error("Trade preview returned no trade amount values");
    }
    return decoded;
}

function toJsonSafe(value: unknown): unknown {
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (value instanceof Uint8Array) {
        return Array.from(value);
    }
    if (Array.isArray(value)) {
        return value.map(toJsonSafe);
    }
    if (isRecord(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, nested]) => [key, toJsonSafe(nested)]),
        );
    }
    return value;
}

function stringifyError(value: unknown): string {
    if (value instanceof Error) {
        return value.stack ?? value.message;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function extractAbortCode(text: string): string | null {
    return text.match(/abort(?:ed)?(?: with code)?[:\s]+([0-9xa-fA-F]+)/i)?.[1] ?? null;
}

function readSimulationStatus(result: unknown): { status: string; error: string | null } {
    if (!isRecord(result)) {
        return { status: "UNKNOWN", error: "Invalid simulation result" };
    }
    if (result.$kind === "FailedTransaction") {
        return { status: "FailedTransaction", error: stringifyError(result.FailedTransaction) };
    }
    if (result.$kind === "Transaction") {
        return { status: "Transaction", error: null };
    }
    return { status: readString(result.$kind, "$kind"), error: null };
}

function readReturnValuesRaw(result: unknown): unknown {
    if (!isRecord(result) || !Array.isArray(result.commandResults)) {
        return null;
    }
    return result.commandResults.flatMap((command) =>
        isRecord(command) && Array.isArray(command.returnValues) ? command.returnValues : [],
    );
}

function readEffectsStatus(result: unknown): unknown {
    if (!isRecord(result)) {
        return null;
    }
    const effects = result.effects;
    return isRecord(effects) ? (effects.status ?? null) : null;
}

function createTradePreviewDebugDetails({
    input,
    quantity,
    betAmountAtomic,
    result,
    caught,
    throwReason,
    decodedReturnValues,
    decodedMintCost,
    decodedRedeemPayout,
}: {
    input: BinaryMarketKeyInput & { sender: string };
    quantity: bigint;
    betAmountAtomic: bigint;
    result: unknown;
    caught: unknown;
    throwReason?: string | null;
    decodedReturnValues?: bigint[];
    decodedMintCost?: bigint | null;
    decodedRedeemPayout?: bigint | null;
}): TradePreviewDebugDetails {
    const status = result ? readSimulationStatus(result) : { status: "THREW", error: null };
    const errorText = status.error ?? (caught ? stringifyError(caught) : null);
    return {
        functionName: "previewTradeAmounts",
        side: input.isUp ? "UP" : "DOWN",
        walletAddress: input.sender,
        currentOracleId: input.oracleId,
        oracleExpiryMs: input.expiryMs,
        referenceStrikeRaw: input.strike.toString(),
        betAmountAtomic: betAmountAtomic.toString(),
        initialQuantity: "1",
        firstPreviewCalled: true,
        buildTransactionCalled: true,
        quantityCandidate: quantity.toString(),
        predictObjectId: PREDICT_BINARY_CONFIG.predictObjectId,
        clockObjectId: PREDICT_BINARY_CONFIG.clockObjectId,
        quoteCoinType: PREDICT_BINARY_CONFIG.quoteCoinType,
        moveTarget: target("predict", "get_trade_amounts"),
        typeArguments: [],
        transactionInputs: {
            predictObjectId: PREDICT_BINARY_CONFIG.predictObjectId,
            oracleObjectId: input.oracleId,
            key: {
                oracleId: input.oracleId,
                expiryMs: input.expiryMs,
                strike: input.strike.toString(),
                isUp: input.isUp,
            },
            quantity: quantity.toString(),
            clockObjectId: PREDICT_BINARY_CONFIG.clockObjectId,
        },
        devInspectSender: input.sender,
        devInspectStatus: status.status,
        devInspectError: errorText,
        moveAbortCode: errorText ? extractAbortCode(errorText) : null,
        returnValuesRaw: result ? toJsonSafe(readReturnValuesRaw(result)) : null,
        throwReason: throwReason ?? null,
        rawDevInspectResponse: result ? toJsonSafe(result) : null,
        effectsStatus: result ? toJsonSafe(readEffectsStatus(result)) : null,
        results: result ? toJsonSafe(readCommandResults(result)) : null,
        decodedReturnValues: decodedReturnValues?.map((value) => value.toString()) ?? [],
        decodedMintCost: decodedMintCost?.toString() ?? null,
        decodedRedeemPayout: decodedRedeemPayout?.toString() ?? null,
    };
}

const loggedFirstPreviewExecutions = new Set<string>();
const loggedReturnValueDecodes = new Set<string>();
const MAX_LOGGED_PREVIEW_KEYS = 1000;

function addBoundedPreviewLogKey(keys: Set<string>, key: string): boolean {
    if (keys.has(key)) {
        return false;
    }
    keys.add(key);
    while (keys.size > MAX_LOGGED_PREVIEW_KEYS) {
        const oldestKey = keys.keys().next().value;
        if (typeof oldestKey !== "string") {
            break;
        }
        keys.delete(oldestKey);
    }
    return true;
}

function logFirstPreviewExecution({
    input,
    budget,
    quantity,
    details,
    firstPreviewResult,
    firstPreviewError,
    throwReason,
}: {
    input: BinaryMarketKeyInput & { sender: string };
    budget: bigint;
    quantity: bigint;
    details: TradePreviewDebugDetails;
    firstPreviewResult: TradeAmounts | null;
    firstPreviewError: string | null;
    throwReason: string | null;
}) {
    if (process.env.DEBUG_PREDICT !== "1") return;
    const side = input.isUp ? "UP" : "DOWN";
    const key = [
        side,
        input.sender,
        input.oracleId,
        input.expiryMs,
        input.strike.toString(),
        budget.toString(),
    ].join(":");
    if (!addBoundedPreviewLogKey(loggedFirstPreviewExecutions, key)) {
        return;
    }
    console.info("Binary odds preview execution", {
        side,
        functionName: "previewTradeWithinBudget",
        betAmountAtomic: budget.toString(),
        initialQuantity: "1",
        firstPreviewCalled: true,
        buildTransactionCalled: true,
        moveTarget: details.moveTarget,
        transactionInputs: details.transactionInputs,
        firstPreviewResult: firstPreviewResult
            ? {
                  mintCost: firstPreviewResult.mintCost.toString(),
                  redeemPayout: firstPreviewResult.redeemPayout.toString(),
              }
            : null,
        firstPreviewError,
        quantityCandidate: quantity.toString(),
        throwReason,
    });
}

function logTradeAmountDecode({
    input,
    quantity,
    result,
    returnValuesRaw,
    decodedReturnValues,
    mintCost,
    redeemPayout,
}: {
    input: BinaryMarketKeyInput & { sender: string };
    quantity: bigint;
    result: unknown;
    returnValuesRaw: unknown;
    decodedReturnValues: bigint[];
    mintCost: bigint;
    redeemPayout: bigint;
}) {
    if (process.env.DEBUG_PREDICT !== "1") return;
    const side = input.isUp ? "UP" : "DOWN";
    const key = [
        side,
        input.sender,
        input.oracleId,
        input.expiryMs,
        input.strike.toString(),
        quantity.toString(),
    ].join(":");
    if (!addBoundedPreviewLogKey(loggedReturnValueDecodes, key)) {
        return;
    }
    console.info("Binary odds preview return decode", {
        side,
        quantity: quantity.toString(),
        rawDevInspectResponse: toJsonSafe(result),
        effectsStatus: toJsonSafe(readEffectsStatus(result)),
        results: toJsonSafe(readCommandResults(result)),
        returnValuesRaw: toJsonSafe(returnValuesRaw),
        returnValuesBeforeDecode: toJsonSafe(
            readCommandReturnValues(
                [...readCommandResults(result)]
                    .reverse()
                    .find((command) => readCommandReturnValues(command).length > 0),
            ),
        ),
        decodedReturnValues: decodedReturnValues.map((value) => value.toString()),
        decodedMintCost: mintCost.toString(),
        decodedRedeemPayout: redeemPayout.toString(),
    });
}

async function previewTradeAmountsWithDebug(
    client: SimulateClient,
    input: BinaryMarketKeyInput & {
        sender: string;
        quantity: bigint;
        betAmountAtomic?: bigint;
    },
): Promise<{ amounts: TradeAmounts; details: TradePreviewDebugDetails }> {
    const transaction = createPreviewTradeAmountsTransaction(input);
    let result: SuiClientTypes.SimulateTransactionResult<{ commandResults: true }> | null = null;
    try {
        result = await client.core.simulateTransaction({
            transaction,
            checksEnabled: false,
            include: { commandResults: true },
        });
        const { mintCost, redeemPayout, decodedReturnValues } = decodeTradeAmountReturns(result);
        const amounts = { mintCost, redeemPayout };
        logTradeAmountDecode({
            input,
            quantity: input.quantity,
            result,
            returnValuesRaw: readReturnValuesRaw(result),
            decodedReturnValues,
            mintCost,
            redeemPayout,
        });
        return {
            amounts,
            details: {
                ...createTradePreviewDebugDetails({
                    input,
                    quantity: input.quantity,
                    betAmountAtomic: input.betAmountAtomic ?? 0n,
                    result,
                    caught: null,
                    decodedReturnValues,
                    decodedMintCost: mintCost,
                    decodedRedeemPayout: redeemPayout,
                }),
                firstPreviewResult: amounts,
                firstPreviewError: null,
            },
        };
    } catch (caught) {
        const details = createTradePreviewDebugDetails({
            input,
            quantity: input.quantity,
            betAmountAtomic: input.betAmountAtomic ?? 0n,
            result,
            caught,
        });
        throw new TradePreviewError("Trade preview failed", {
            ...details,
            firstPreviewResult: null,
            firstPreviewError: details.devInspectError,
        });
    }
}

export async function simulateU64Returns(client: SimulateClient, transaction: Transaction) {
    return parseU64Return(
        await client.core.simulateTransaction({
            transaction,
            checksEnabled: false,
            include: { commandResults: true },
        }),
    );
}

export async function readWalletQuoteBalance(
    client: SimulateClient,
    owner: string,
): Promise<bigint> {
    const response = await client.core.getBalance({
        owner,
        coinType: PREDICT_BINARY_CONFIG.quoteCoinType,
    });
    return readBigInt(response.balance.balance, "wallet quote balance");
}

export async function readManagerBalance(
    client: SimulateClient,
    sender: string,
    managerId: string,
): Promise<bigint> {
    const values = await simulateU64Returns(
        client,
        createReadManagerBalanceTransaction({ sender, managerId }),
    );
    return values[0] ?? 0n;
}

export async function readBinaryPosition(
    client: SimulateClient,
    input: BinaryMarketKeyInput & { sender: string; managerId: string },
): Promise<bigint> {
    const values = await simulateU64Returns(client, createReadBinaryPositionTransaction(input));
    return values[0] ?? 0n;
}

export async function previewTradeAmountsServerOnly(
    client: SimulateClient,
    input: BinaryMarketKeyInput & {
        sender: string;
        quantity: bigint;
        betAmountAtomic?: bigint;
    },
): Promise<TradeAmounts> {
    return (await previewTradeAmountsWithDebug(client, input)).amounts;
}

export async function previewRangeTradeAmountsServerOnly(
    client: SimulateClient,
    input: RangeKeyInput & {
        sender: string;
        quantity: bigint;
    },
): Promise<TradeAmounts> {
    const result = await client.core.simulateTransaction({
        transaction: createPreviewRangeTradeAmountsTransaction(input),
        checksEnabled: false,
        include: { commandResults: true },
    });
    const { mintCost, redeemPayout } = decodeTradeAmountReturns(result);
    return { mintCost, redeemPayout };
}

export async function previewRangeWithinBudgetServerOnly({
    client,
    budget,
    ...input
}: RangeKeyInput & {
    client: SimulateClient;
    sender: string;
    budget: bigint;
}): Promise<RangeTradePreview> {
    const preview = await findBudgetedTradePreview({
        budget,
        preview: (quantity) =>
            previewRangeTradeAmountsServerOnly(client, {
                ...input,
                quantity,
            }),
    });
    return {
        quantity: preview.quantity,
        mintCost: preview.mintCost,
        redeemPayout: preview.redeemPayout,
    };
}

async function previewRangeBatchTradeAmounts({
    client,
    sender,
    quantities,
    ...input
}: RangeKeyInput & {
    client: SimulateClient;
    sender: string;
    quantities: bigint[];
}): Promise<RangeTradePreview[]> {
    const batchInputs: BatchRangePreviewInput[] = quantities.map((quantity) => ({
        key: input,
        quantity,
    }));
    const result = await client.core.simulateTransaction({
        transaction: createBatchRangePreviewTransaction({ sender, inputs: batchInputs }),
        checksEnabled: false,
        include: { commandResults: true },
    });
    const amounts = decodeAllTradeAmountReturns(result);
    if (amounts.length !== quantities.length) {
        throw new Error("Batch range preview returned an unexpected number of results");
    }
    return quantities.map((quantity, index) => {
        const amount = amounts[index];
        if (!amount) {
            throw new Error("Batch range preview result is missing");
        }
        return { quantity, ...amount };
    });
}

async function previewRangeWithinBudgetBatched({
    client,
    budget,
    ...input
}: RangeKeyInput & {
    client: SimulateClient;
    sender: string;
    budget: bigint;
}): Promise<RangeTradePreview> {
    if (budget <= 0n) {
        throw new Error("Amount must be greater than zero");
    }

    const firstQuantities = buildPreviewCandidateQuantities(budget);
    const firstBatch = await previewRangeBatchTradeAmounts({
        client,
        ...input,
        quantities: firstQuantities,
    });
    const secondQuantities = buildVerificationQuantities({ budget, candidates: firstBatch }).filter(
        (quantity) => !firstQuantities.includes(quantity),
    );
    const secondBatch =
        secondQuantities.length > 0
            ? await previewRangeBatchTradeAmounts({
                  client,
                  ...input,
                  quantities: secondQuantities,
              })
            : [];
    const candidates = [...firstBatch, ...secondBatch];
    const best = selectBestBudgetedPreview(budget, candidates);
    if (!best) {
        throw new Error("Amount is too small for a mintable range quantity");
    }
    if (process.env.DEBUG_PREDICT === "1") {
        console.info("Range preview batch search", {
            rpcBatches: secondBatch.length > 0 ? 2 : 1,
            candidates: candidates.length,
            quantity: best.quantity.toString(),
            mintCost: best.mintCost.toString(),
            redeemPayout: best.redeemPayout.toString(),
        });
    }
    return best;
}

export async function previewRangeWithinBudgetFast(
    input: RangeKeyInput & {
        client: SimulateClient;
        sender: string;
        budget: bigint;
    },
): Promise<RangeTradePreview> {
    try {
        return await previewRangeWithinBudgetBatched(input);
    } catch (caught) {
        console.warn("Range preview batch search fell back to single-call search", {
            reason: caught instanceof Error ? caught.message : String(caught),
        });
        return previewRangeWithinBudgetFastFallback(input);
    }
}

async function previewRangeWithinBudgetFastFallback({
    client,
    budget,
    ...input
}: RangeKeyInput & {
    client: SimulateClient;
    sender: string;
    budget: bigint;
}): Promise<RangeTradePreview> {
    if (budget <= 0n) {
        throw new Error("Amount must be greater than zero");
    }

    const seen = new Set<string>();
    let attempts = 0;
    let best: RangeTradePreview | null = null;
    let lastMintCost: string | null = null;
    let lastRedeemPayout: string | null = null;
    let lastQuantity = 1n;

    const previewQuantity = async (quantity: bigint): Promise<RangeTradePreview | null> => {
        const normalized = quantity > 0n ? quantity : 1n;
        const key = normalized.toString();
        if (seen.has(key)) {
            return null;
        }
        seen.add(key);
        attempts += 1;
        lastQuantity = normalized;
        const amounts = await previewRangeTradeAmountsServerOnly(client, {
            ...input,
            quantity: normalized,
        });
        lastMintCost = amounts.mintCost.toString();
        lastRedeemPayout = amounts.redeemPayout.toString();
        const candidate = {
            quantity: normalized,
            mintCost: amounts.mintCost,
            redeemPayout: amounts.redeemPayout,
        };
        if (amounts.mintCost > 0n && amounts.mintCost <= budget) {
            if (!best || candidate.quantity > best.quantity) {
                best = candidate;
            }
        }
        return candidate;
    };

    let probeQuantity = budget;
    let probe = await previewQuantity(probeQuantity);
    for (let probeAttempts = 0; probe?.mintCost === 0n && probeAttempts < 8; probeAttempts += 1) {
        probeQuantity *= 2n;
        probe = await previewQuantity(probeQuantity);
    }

    if (!probe || probe.mintCost <= 0n) {
        throw new Error("Amount is too small for a mintable range quantity");
    }

    let nextQuantity = (budget * probe.quantity) / probe.mintCost;
    if (nextQuantity <= 0n) {
        nextQuantity = 1n;
    }

    for (let refineAttempts = 0; refineAttempts < 3; refineAttempts += 1) {
        const result = await previewQuantity(nextQuantity);
        if (!result) {
            nextQuantity += 1n;
            continue;
        }
        if (result.mintCost > 0n) {
            const adjusted = (budget * result.quantity) / result.mintCost;
            if (adjusted === nextQuantity) {
                nextQuantity = result.mintCost <= budget ? nextQuantity + 1n : nextQuantity - 1n;
            } else {
                nextQuantity = adjusted > 0n ? adjusted : 1n;
            }
        } else {
            nextQuantity *= 2n;
        }
    }

    if (!best) {
        if (process.env.DEBUG_PREDICT === "1") {
            console.info("Range preview fast search no mintable quantity", {
                attempts,
                lastTriedQuantity: lastQuantity.toString(),
                lastMintCost,
                lastRedeemPayout,
                budget: budget.toString(),
            });
        }
        throw new Error("Amount is too small for a mintable range quantity");
    }

    const finalBest = best as RangeTradePreview;
    if (process.env.DEBUG_PREDICT === "1") {
        console.info("Range preview fast search", {
            attempts,
            quantity: finalBest.quantity.toString(),
            mintCost: finalBest.mintCost.toString(),
            redeemPayout: finalBest.redeemPayout.toString(),
        });
    }
    return finalBest;
}

export async function previewTradeWithinBudgetServerOnly({
    client,
    sender,
    oracleId,
    expiryMs,
    strike,
    isUp,
    budget,
}: {
    client: SimulateClient;
    sender: string;
    oracleId: string;
    expiryMs: number;
    strike: bigint;
    isUp: boolean;
    budget: bigint;
}): Promise<BudgetedTradePreview> {
    if (budget <= 0n) {
        throw new Error("Amount must be greater than zero");
    }

    const baseInput = { sender, oracleId, expiryMs, strike, isUp, betAmountAtomic: budget };
    const initialQuantity = 1n;
    let lastQuantityCandidate: bigint | null = null;
    let lastPreviewDetails: TradePreviewDebugDetails | null = null;
    let lastPreviewAmounts: TradeAmounts | null = null;
    const detailsByQuantity = new Map<string, TradePreviewDebugDetails>();
    let firstPreviewLogged = false;
    const preview = await findBudgetedTradePreview({
        budget,
        preview: async (quantity) => {
            lastQuantityCandidate = quantity;
            try {
                const { amounts, details } = await previewTradeAmountsWithDebug(client, {
                    ...baseInput,
                    quantity,
                });
                lastPreviewDetails = details;
                lastPreviewAmounts = amounts;
                detailsByQuantity.set(quantity.toString(), details);
                if (!firstPreviewLogged) {
                    firstPreviewLogged = true;
                    logFirstPreviewExecution({
                        input: baseInput,
                        budget,
                        quantity,
                        details,
                        firstPreviewResult: amounts,
                        firstPreviewError: null,
                        throwReason: null,
                    });
                }
                return amounts;
            } catch (caught) {
                if (caught instanceof TradePreviewError) {
                    lastPreviewDetails = caught.details;
                    if (!firstPreviewLogged) {
                        firstPreviewLogged = true;
                        logFirstPreviewExecution({
                            input: baseInput,
                            budget,
                            quantity,
                            details: caught.details,
                            firstPreviewResult: null,
                            firstPreviewError: caught.details.devInspectError,
                            throwReason: caught.message,
                        });
                    }
                }
                throw caught;
            }
        },
        createNoMintableQuantityError: ({ attempts }) => {
            const throwReason = "Amount is too small for a mintable quantity";
            const details =
                lastPreviewDetails ??
                createTradePreviewDebugDetails({
                    input: baseInput,
                    quantity: lastQuantityCandidate ?? initialQuantity,
                    betAmountAtomic: budget,
                    result: null,
                    caught: new Error(throwReason),
                    throwReason,
                });
            console.error("Binary odds preview no mintable quantity", {
                side: isUp ? "UP" : "DOWN",
                lastTriedQuantity: (lastQuantityCandidate ?? initialQuantity).toString(),
                lastMintCost: lastPreviewAmounts?.mintCost.toString() ?? null,
                lastRedeemPayout: lastPreviewAmounts?.redeemPayout.toString() ?? null,
                attempts,
                searchLimit: 96,
                reason: "No candidate satisfied mintCost > 0 and mintCost <= betAmountAtomic after exponential search",
            });
            return new TradePreviewError(throwReason, {
                ...details,
                functionName: "previewTradeWithinBudget",
                quantityCandidate: (lastQuantityCandidate ?? initialQuantity).toString(),
                throwReason,
                devInspectError: details.devInspectError ?? throwReason,
            });
        },
    });
    return {
        ...preview,
        debug:
            detailsByQuantity.get(preview.quantity.toString()) ?? lastPreviewDetails ?? undefined,
    };
}

type BudgetedBinaryMarketInput = BinaryMarketKeyInput & { budget: bigint };

interface BinaryBatchRequest {
    marketIndex: number;
    key: BudgetedBinaryMarketInput;
    quantity: bigint;
}

async function simulateBinaryBatchRequests({
    client,
    sender,
    requests,
}: {
    client: SimulateClient;
    sender: string;
    requests: BinaryBatchRequest[];
}): Promise<Array<{ marketIndex: number; preview: BudgetedTradePreview }>> {
    if (requests.length === 0) {
        return [];
    }
    const result = await client.core.simulateTransaction({
        transaction: createBatchPreviewTransaction({ sender, inputs: requests }),
        checksEnabled: false,
        include: { commandResults: true },
    });
    const amounts = decodeAllTradeAmountReturns(result);
    if (amounts.length !== requests.length) {
        throw new Error("Batch binary preview returned an unexpected number of results");
    }
    return requests.map((request, index) => {
        const amount = amounts[index];
        if (!amount) {
            throw new Error("Batch binary preview result is missing");
        }
        const decodedReturnValues = [amount.mintCost, amount.redeemPayout];
        const debugInput = {
            sender,
            oracleId: request.key.oracleId,
            expiryMs: request.key.expiryMs,
            strike: request.key.strike,
            isUp: request.key.isUp,
        };
        const details = createTradePreviewDebugDetails({
            input: debugInput,
            quantity: request.quantity,
            betAmountAtomic: request.key.budget,
            result,
            caught: null,
            decodedReturnValues,
            decodedMintCost: amount.mintCost,
            decodedRedeemPayout: amount.redeemPayout,
        });
        logTradeAmountDecode({
            input: debugInput,
            quantity: request.quantity,
            result,
            returnValuesRaw: readReturnValuesRaw(result),
            decodedReturnValues,
            mintCost: amount.mintCost,
            redeemPayout: amount.redeemPayout,
        });
        return {
            marketIndex: request.marketIndex,
            preview: {
                quantity: request.quantity,
                firstTriedQuantity: request.key.budget,
                ...amount,
                debug: details,
            },
        };
    });
}

async function previewBudgetedBinaryMarketsBatched({
    client,
    sender,
    markets,
}: {
    client: SimulateClient;
    sender: string;
    markets: BudgetedBinaryMarketInput[];
}): Promise<BudgetedTradePreview[]> {
    for (const market of markets) {
        if (market.budget <= 0n) {
            throw new Error("Amount must be greater than zero");
        }
    }
    const firstRequests = markets.flatMap((market, marketIndex) =>
        buildPreviewCandidateQuantities(market.budget).map((quantity) => ({
            marketIndex,
            key: market,
            quantity,
        })),
    );
    const firstResults = await simulateBinaryBatchRequests({
        client,
        sender,
        requests: firstRequests,
    });
    const requestsByMarket = new Map<number, BinaryBatchRequest[]>();
    for (const request of firstRequests) {
        const requests = requestsByMarket.get(request.marketIndex) ?? [];
        requests.push(request);
        requestsByMarket.set(request.marketIndex, requests);
    }
    const previewsByMarket = new Map<number, BudgetedTradePreview[]>();
    for (const result of firstResults) {
        const previews = previewsByMarket.get(result.marketIndex) ?? [];
        previews.push(result.preview);
        previewsByMarket.set(result.marketIndex, previews);
    }

    const secondRequests = markets.flatMap((market, marketIndex) => {
        const firstQuantities = new Set(
            (requestsByMarket.get(marketIndex) ?? []).map((request) => request.quantity.toString()),
        );
        return buildVerificationQuantities({
            budget: market.budget,
            candidates: previewsByMarket.get(marketIndex) ?? [],
        })
            .filter((quantity) => !firstQuantities.has(quantity.toString()))
            .map((quantity) => ({ marketIndex, key: market, quantity }));
    });
    const secondResults = await simulateBinaryBatchRequests({
        client,
        sender,
        requests: secondRequests,
    });
    for (const result of secondResults) {
        const previews = previewsByMarket.get(result.marketIndex) ?? [];
        previews.push(result.preview);
        previewsByMarket.set(result.marketIndex, previews);
    }

    return markets.map((market, marketIndex) => {
        const candidates = previewsByMarket.get(marketIndex) ?? [];
        const best = selectBestBudgetedPreview(market.budget, candidates);
        if (!best) {
            const last = candidates.at(-1);
            const throwReason = "Amount is too small for a mintable quantity";
            throw new TradePreviewError(
                throwReason,
                createTradePreviewDebugDetails({
                    input: {
                        sender,
                        oracleId: market.oracleId,
                        expiryMs: market.expiryMs,
                        strike: market.strike,
                        isUp: market.isUp,
                    },
                    quantity: last?.quantity ?? 1n,
                    betAmountAtomic: market.budget,
                    result: null,
                    caught: new Error(throwReason),
                    throwReason,
                    decodedMintCost: last?.mintCost ?? null,
                    decodedRedeemPayout: last?.redeemPayout ?? null,
                }),
            );
        }
        if (process.env.DEBUG_PREDICT === "1") {
            console.info("Binary odds preview batch search", {
                side: market.isUp ? "UP" : "DOWN",
                rpcBatches: secondRequests.length > 0 ? 2 : 1,
                candidates: candidates.length,
                quantity: best.quantity.toString(),
                mintCost: best.mintCost.toString(),
                redeemPayout: best.redeemPayout.toString(),
            });
        }
        return best;
    });
}

export async function previewBinarySidesWithinBudgetFast({
    client,
    sender,
    oracleId,
    expiryMs,
    strike,
    budget,
}: {
    client: SimulateClient;
    sender: string;
    oracleId: string;
    expiryMs: number;
    strike: bigint;
    budget: bigint;
}): Promise<{ up: BudgetedTradePreview; down: BudgetedTradePreview }> {
    try {
        const [up, down] = await previewBudgetedBinaryMarketsBatched({
            client,
            sender,
            markets: [
                { oracleId, expiryMs, strike, isUp: true, budget },
                { oracleId, expiryMs, strike, isUp: false, budget },
            ],
        });
        if (!up || !down) {
            throw new Error("Batch binary side preview result is missing");
        }
        return { up, down };
    } catch (caught) {
        console.warn("Binary side batch preview fell back to per-side search", {
            reason: caught instanceof Error ? caught.message : String(caught),
        });
        const [up, down] = await Promise.all([
            previewTradeWithinBudgetFastFallback({
                client,
                sender,
                oracleId,
                expiryMs,
                strike,
                isUp: true,
                budget,
            }),
            previewTradeWithinBudgetFastFallback({
                client,
                sender,
                oracleId,
                expiryMs,
                strike,
                isUp: false,
                budget,
            }),
        ]);
        return { up, down };
    }
}

export async function previewBreakWithinBudgetFast({
    client,
    sender,
    oracleId,
    expiryMs,
    lowerStrike,
    higherStrike,
    lowerBudget,
    upperBudget,
}: {
    client: SimulateClient;
    sender: string;
    oracleId: string;
    expiryMs: number;
    lowerStrike: bigint;
    higherStrike: bigint;
    lowerBudget: bigint;
    upperBudget: bigint;
}): Promise<{ lowerLeg: BudgetedTradePreview; upperLeg: BudgetedTradePreview }> {
    try {
        const [lowerLeg, upperLeg] = await previewBudgetedBinaryMarketsBatched({
            client,
            sender,
            markets: [
                { oracleId, expiryMs, strike: lowerStrike, isUp: false, budget: lowerBudget },
                { oracleId, expiryMs, strike: higherStrike, isUp: true, budget: upperBudget },
            ],
        });
        if (!lowerLeg || !upperLeg) {
            throw new Error("Batch break preview result is missing");
        }
        return { lowerLeg, upperLeg };
    } catch (caught) {
        console.warn("Break batch preview fell back to per-leg search", {
            reason: caught instanceof Error ? caught.message : String(caught),
        });
        const [lowerLeg, upperLeg] = await Promise.all([
            previewTradeWithinBudgetFastFallback({
                client,
                sender,
                oracleId,
                expiryMs,
                strike: lowerStrike,
                isUp: false,
                budget: lowerBudget,
            }),
            previewTradeWithinBudgetFastFallback({
                client,
                sender,
                oracleId,
                expiryMs,
                strike: higherStrike,
                isUp: true,
                budget: upperBudget,
            }),
        ]);
        return { lowerLeg, upperLeg };
    }
}

async function previewTradeWithinBudgetBatched({
    client,
    sender,
    oracleId,
    expiryMs,
    strike,
    isUp,
    budget,
}: {
    client: SimulateClient;
    sender: string;
    oracleId: string;
    expiryMs: number;
    strike: bigint;
    isUp: boolean;
    budget: bigint;
}): Promise<BudgetedTradePreview> {
    if (budget <= 0n) {
        throw new Error("Amount must be greater than zero");
    }

    const [preview] = await previewBudgetedBinaryMarketsBatched({
        client,
        sender,
        markets: [{ oracleId, expiryMs, strike, isUp, budget }],
    });
    if (!preview) {
        throw new Error("Batch binary preview result is missing");
    }
    return preview;
}

export async function previewTradeWithinBudgetFast(input: {
    client: SimulateClient;
    sender: string;
    oracleId: string;
    expiryMs: number;
    strike: bigint;
    isUp: boolean;
    budget: bigint;
}): Promise<BudgetedTradePreview> {
    try {
        return await previewTradeWithinBudgetBatched(input);
    } catch (caught) {
        console.warn("Binary preview batch search fell back to single-call search", {
            side: input.isUp ? "UP" : "DOWN",
            reason: caught instanceof Error ? caught.message : String(caught),
        });
        return previewTradeWithinBudgetFastFallback(input);
    }
}

async function previewTradeWithinBudgetFastFallback({
    client,
    sender,
    oracleId,
    expiryMs,
    strike,
    isUp,
    budget,
}: {
    client: SimulateClient;
    sender: string;
    oracleId: string;
    expiryMs: number;
    strike: bigint;
    isUp: boolean;
    budget: bigint;
}): Promise<BudgetedTradePreview> {
    if (budget <= 0n) {
        throw new Error("Amount must be greater than zero");
    }

    const baseInput = { sender, oracleId, expiryMs, strike, isUp, betAmountAtomic: budget };
    const seen = new Set<string>();
    let attempts = 0;
    let best: BudgetedTradePreview | null = null;
    let lastDetails: TradePreviewDebugDetails | null = null;
    let lastMintCost: string | null = null;
    let lastRedeemPayout: string | null = null;
    let lastQuantity = 1n;

    const previewQuantity = async (quantity: bigint): Promise<BudgetedTradePreview | null> => {
        const normalized = quantity > 0n ? quantity : 1n;
        const key = normalized.toString();
        if (seen.has(key)) {
            return null;
        }
        seen.add(key);
        attempts += 1;
        lastQuantity = normalized;
        const { amounts, details } = await previewTradeAmountsWithDebug(client, {
            ...baseInput,
            quantity: normalized,
        });
        lastDetails = details;
        lastMintCost = amounts.mintCost.toString();
        lastRedeemPayout = amounts.redeemPayout.toString();
        if (amounts.mintCost > 0n && amounts.mintCost <= budget) {
            const candidate = {
                quantity: normalized,
                firstTriedQuantity: budget,
                ...amounts,
                debug: details,
            };
            if (!best || candidate.quantity > best.quantity) {
                best = candidate;
            }
            return candidate;
        }
        return {
            quantity: normalized,
            firstTriedQuantity: budget,
            ...amounts,
            debug: details,
        };
    };

    let probeQuantity = budget;
    let probe = await previewQuantity(probeQuantity);
    for (let probeAttempts = 0; probe?.mintCost === 0n && probeAttempts < 8; probeAttempts += 1) {
        probeQuantity *= 2n;
        probe = await previewQuantity(probeQuantity);
    }

    if (!probe || probe.mintCost <= 0n) {
        const throwReason = "Amount is too small for a mintable quantity";
        throw new TradePreviewError(throwReason, {
            ...(lastDetails ??
                createTradePreviewDebugDetails({
                    input: baseInput,
                    quantity: lastQuantity,
                    betAmountAtomic: budget,
                    result: null,
                    caught: new Error(throwReason),
                    throwReason,
                })),
            functionName: "previewTradeWithinBudgetFast",
            quantityCandidate: lastQuantity.toString(),
            decodedMintCost: lastMintCost,
            decodedRedeemPayout: lastRedeemPayout,
            throwReason,
        });
    }

    let nextQuantity = (budget * probe.quantity) / probe.mintCost;
    if (nextQuantity <= 0n) {
        nextQuantity = 1n;
    }

    for (let refineAttempts = 0; refineAttempts < 3; refineAttempts += 1) {
        const result = await previewQuantity(nextQuantity);
        if (!result) {
            nextQuantity += 1n;
            continue;
        }
        if (result.mintCost > 0n) {
            const adjusted = (budget * result.quantity) / result.mintCost;
            if (adjusted === nextQuantity) {
                nextQuantity = result.mintCost <= budget ? nextQuantity + 1n : nextQuantity - 1n;
            } else {
                nextQuantity = adjusted > 0n ? adjusted : 1n;
            }
        } else {
            nextQuantity *= 2n;
        }
    }

    if (!best) {
        const throwReason = "Amount is too small for a mintable quantity";
        console.error("Binary odds preview no mintable quantity", {
            side: isUp ? "UP" : "DOWN",
            lastTriedQuantity: lastQuantity.toString(),
            lastMintCost,
            lastRedeemPayout,
            attempts,
            searchLimit: 12,
            reason: "No fast preview candidate satisfied mintCost > 0 and mintCost <= betAmountAtomic",
        });
        throw new TradePreviewError(throwReason, {
            ...(lastDetails ??
                createTradePreviewDebugDetails({
                    input: baseInput,
                    quantity: lastQuantity,
                    betAmountAtomic: budget,
                    result: null,
                    caught: new Error(throwReason),
                    throwReason,
                })),
            functionName: "previewTradeWithinBudgetFast",
            quantityCandidate: lastQuantity.toString(),
            decodedMintCost: lastMintCost,
            decodedRedeemPayout: lastRedeemPayout,
            throwReason,
        });
    }

    const finalBest = best as BudgetedTradePreview;
    if (process.env.DEBUG_PREDICT === "1") {
        console.info("Binary odds preview fast search", {
            side: isUp ? "UP" : "DOWN",
            attempts,
            quantity: finalBest.quantity.toString(),
            mintCost: finalBest.mintCost.toString(),
            redeemPayout: finalBest.redeemPayout.toString(),
        });
    }
    return finalBest;
}

export async function calculateQuantityWithinBudget({
    client,
    sender,
    managerId,
    market,
    isUp,
    budget,
    managerBalance,
}: {
    client: SimulateClient;
    sender: string;
    managerId: string;
    market: BtcBinaryMarket;
    isUp: boolean;
    budget: bigint;
    managerBalance: bigint;
}): Promise<{ quantity: bigint; cost: bigint; askPrice: bigint; depositAmount: bigint }> {
    let low = 1n;
    let high = 1n;
    let best = { quantity: 0n, cost: 0n, askPrice: 0n };
    const simulateMint = async (quantity: bigint): Promise<MintEvent | null> => {
        const maxTotalCost = calcMaxTotalCost(budget, PREDICT_BINARY_CONFIG.feeBps);
        const depositAmount = maxTotalCost > managerBalance ? maxTotalCost - managerBalance : 0n;
        const tx = createMintBinaryTransaction({
            sender,
            managerId,
            oracleId: market.oracleId,
            expiryMs: market.expiryMs,
            strike: market.strike,
            isUp,
            quantity,
            depositAmount,
            maxTotalCost,
        });
        try {
            const simulated = await client.core.simulateTransaction({
                transaction: tx,
                include: { events: true },
            });
            return simulated.$kind === "Transaction"
                ? readMintEvent(simulated.Transaction.events)
                : null;
        } catch {
            return null;
        }
    };

    for (let attempts = 0; attempts < 96; attempts += 1) {
        const event = await simulateMint(high);
        if (!event || event.cost > budget) {
            break;
        }
        if (event.cost > 0n) {
            best = { quantity: high, cost: event.cost, askPrice: event.askPrice };
        }
        high *= 2n;
    }

    while (low <= high) {
        const quantity = (low + high) / 2n;
        const event = await simulateMint(quantity);
        if (event && event.cost > 0n && event.cost <= budget) {
            best = { quantity, cost: event.cost, askPrice: event.askPrice };
            low = quantity + 1n;
        } else {
            high = quantity - 1n;
        }
    }

    if (best.quantity <= 0n) {
        throw new Error("Amount is too small for a mintable quantity");
    }

    return {
        ...best,
        depositAmount: best.cost > managerBalance ? best.cost - managerBalance : 0n,
    };
}

// Arena players テーブル ID のモジュールキャッシュ (初回取得後は RPC 不要)
let cachedPlayersTableId: string | null = null;

async function fetchPlayersTableId(): Promise<string | null> {
    if (cachedPlayersTableId) return cachedPlayersTableId;
    try {
        const response = await fetch(PREDICT_BINARY_CONFIG.fullnodeJsonRpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "sui_getObject",
                params: [PREDICT_BINARY_CONFIG.arenaObjectId, { showContent: true }],
            }),
        });
        if (!response.ok) return null;
        const payload = (await response.json()) as unknown;
        if (!isRecord(payload) || !isRecord(payload.result)) return null;
        const data = isRecord(payload.result.data) ? payload.result.data : null;
        const content = data && isRecord(data.content) ? data.content : null;
        const fields = content && isRecord(content.fields) ? content.fields : null;
        const players = fields && isRecord(fields.players) ? fields.players : null;
        const playersFields = players && isRecord(players.fields) ? players.fields : null;
        const playersIdObj = playersFields && isRecord(playersFields.id) ? playersFields.id : null;
        const tableId =
            playersIdObj && typeof playersIdObj.id === "string" ? playersIdObj.id : null;
        if (tableId) cachedPlayersTableId = tableId;
        return tableId;
    } catch {
        return null;
    }
}

export async function checkArenaPlayerJoined(playerAddress: string): Promise<boolean> {
    try {
        const playersTableId = await fetchPlayersTableId();
        if (!playersTableId) return false;
        const response = await fetch(PREDICT_BINARY_CONFIG.fullnodeJsonRpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "suix_getDynamicFieldObject",
                params: [playersTableId, { type: "address", value: playerAddress }],
            }),
        });
        if (!response.ok) return false;
        const payload = (await response.json()) as unknown;
        if (!isRecord(payload) || isRecord(payload.error)) return false;
        const data = isRecord(payload.result) ? payload.result.data : null;
        return isRecord(data);
    } catch {
        return false;
    }
}

// PredictManager の localStorage キャッシュ (キー: deeparena:predictManager:{address})
const MANAGER_CACHE_KEY_PREFIX = "deeparena:predictManager:";

export function saveCachedManagerId(address: string, managerId: string): void {
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem(`${MANAGER_CACHE_KEY_PREFIX}${address.toLowerCase()}`, managerId);
    } catch {}
}

function readCachedManagerId(address: string): string | null {
    if (typeof window === "undefined") return null;
    try {
        return localStorage.getItem(`${MANAGER_CACHE_KEY_PREFIX}${address.toLowerCase()}`);
    } catch {
        return null;
    }
}

export async function findPredictManager(owner: string): Promise<string | null> {
    const cached = readCachedManagerId(owner);
    if (cached) return cached;

    const managerCreatedType = `${PREDICT_BINARY_CONFIG.packageId}::predict_manager::PredictManagerCreated`;
    let cursor: unknown = null;
    for (let page = 0; page < 10; page += 1) {
        const response = await fetch(PREDICT_BINARY_CONFIG.fullnodeJsonRpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: page + 1,
                method: "suix_queryTransactionBlocks",
                params: [
                    { filter: { FromAddress: owner }, options: { showEvents: true } },
                    cursor,
                    50,
                    true,
                ],
            }),
        });
        if (!response.ok) {
            throw new Error(`Manager TX query failed: ${response.status}`);
        }
        const payload = (await response.json()) as unknown;
        if (
            !isRecord(payload) ||
            !isRecord(payload.result) ||
            !Array.isArray(payload.result.data)
        ) {
            throw new Error("Invalid manager TX query response");
        }
        for (const tx of payload.result.data) {
            if (!isRecord(tx) || !Array.isArray(tx.events)) continue;
            for (const event of tx.events) {
                if (!isRecord(event) || !isRecord(event.parsedJson)) continue;
                if (event.type !== managerCreatedType) continue;
                const eventOwner =
                    typeof event.parsedJson.owner === "string"
                        ? event.parsedJson.owner.toLowerCase()
                        : "";
                if (eventOwner !== owner.toLowerCase()) continue;
                const managerId = readString(event.parsedJson.manager_id, "manager_id");
                saveCachedManagerId(owner, managerId);
                return managerId;
            }
        }
        if (payload.result.hasNextPage !== true) {
            return null;
        }
        cursor = payload.result.nextCursor;
    }
    return null;
}

export function readManagerCreatedEvent(events: unknown[] | undefined): string | null {
    const event = events?.find((item) => {
        if (!isRecord(item)) {
            return false;
        }
        return (
            item.eventType ===
                `${PREDICT_BINARY_CONFIG.packageId}::predict_manager::PredictManagerCreated` ||
            item.type ===
                `${PREDICT_BINARY_CONFIG.packageId}::predict_manager::PredictManagerCreated`
        );
    });
    const payload = readSuiEventPayload(event);
    return payload ? readString(payload.manager_id, "manager_id") : null;
}

export const POSITION_MINTED_EVENT_TYPE = `${PREDICT_BINARY_CONFIG.packageId}::predict::PositionMinted`;
export const RANGE_MINTED_EVENT_TYPE = `${PREDICT_BINARY_CONFIG.packageId}::predict::RangeMinted`;

export function findMintEvent(events: unknown[] | undefined): unknown | null {
    return (
        events?.find((item) => {
            if (!isRecord(item)) {
                return false;
            }
            if (item.eventType === POSITION_MINTED_EVENT_TYPE) {
                return true;
            }
            return item.type === POSITION_MINTED_EVENT_TYPE;
        }) ?? null
    );
}

export function readMintEvent(events: unknown[] | undefined): MintEvent {
    const event = findMintEvent(events);
    const minted = readPositionMintedEvent(event);
    return {
        predictId: minted.predictId,
        managerId: minted.managerId,
        oracleId: minted.oracleId,
        expiryMs: minted.expiryMs,
        strike: minted.strike,
        isUp: minted.isUp,
        quantity: minted.quantity,
        cost: minted.cost,
        askPrice: minted.askPrice,
    };
}

export function readPositionMintedEvent(event: unknown): MintedPositionEvent {
    const payload = readSuiEventPayload(event);
    if (!payload) {
        throw new Error("PositionMinted event was not found");
    }
    return {
        predictId: readString(payload.predict_id, "predict_id"),
        managerId: readString(payload.manager_id, "manager_id"),
        trader: readString(payload.trader, "trader"),
        quoteAssetName: readQuoteAssetName(payload.quote_asset),
        oracleId: readString(payload.oracle_id, "oracle_id"),
        expiryMs: Number(readBigInt(payload.expiry, "expiry")),
        strike: readBigInt(payload.strike, "strike"),
        isUp: readBoolean(payload.is_up, "is_up"),
        quantity: readBigInt(payload.quantity, "quantity"),
        cost: readBigInt(payload.cost, "cost"),
        askPrice: readBigInt(payload.ask_price, "ask_price"),
        digest: readEventDigest(event),
        timestampMs: readEventTimestampMs(event),
    };
}

export function findRangeMintedEvent(events: unknown[] | undefined): unknown | null {
    return (
        events?.find((item) => {
            if (!isRecord(item)) {
                return false;
            }
            return (
                item.eventType === RANGE_MINTED_EVENT_TYPE || item.type === RANGE_MINTED_EVENT_TYPE
            );
        }) ?? null
    );
}

export function readRangeMintedEvent(events: unknown[] | undefined): RangeMintEvent {
    const payloadEvent = findRangeMintedEvent(events);
    const payload = readSuiEventPayload(payloadEvent);
    if (!payload) {
        throw new Error("RangeMinted event was not found");
    }
    return {
        predictId: readString(payload.predict_id, "predict_id"),
        managerId: readString(payload.manager_id, "manager_id"),
        trader: readString(payload.trader, "trader"),
        quoteAssetName: readQuoteAssetName(payload.quote_asset),
        oracleId: readString(payload.oracle_id, "oracle_id"),
        expiryMs: Number(readBigInt(payload.expiry, "expiry")),
        lowerStrike: readBigInt(payload.lower_strike, "lower_strike"),
        higherStrike: readBigInt(payload.higher_strike, "higher_strike"),
        quantity: readBigInt(payload.quantity, "quantity"),
        cost: readBigInt(payload.cost, "cost"),
        askPrice: readBigInt(payload.ask_price, "ask_price"),
        digest: readEventDigest(payloadEvent),
        timestampMs: readEventTimestampMs(payloadEvent),
    };
}

interface QueryMoveEventsOptions {
    eventType: string;
    maxPages: number;
    pageSize: number;
}

const EVENT_QUERY_MAX_ATTEMPTS = 3;
const EVENT_QUERY_RETRY_BASE_DELAY_MS = 600;

function delayMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchEventQueryPage(requestBody: string, eventType: string): Promise<unknown> {
    let lastReason = "unknown";
    for (let attempt = 1; attempt <= EVENT_QUERY_MAX_ATTEMPTS; attempt += 1) {
        try {
            const response = await fetch(PREDICT_BINARY_CONFIG.fullnodeJsonRpcUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: requestBody,
            });
            if (response.ok) {
                return (await response.json()) as unknown;
            }
            lastReason = `${response.status}`;
            if (response.status !== 429 && response.status < 500) {
                break;
            }
        } catch (caught) {
            // fullnode のレートリミット応答には CORS ヘッダが付かないため、
            // ブラウザでは fetch 自体が "Failed to fetch" で reject する。リトライ対象にする。
            lastReason = caught instanceof Error ? caught.message : String(caught);
        }
        if (attempt < EVENT_QUERY_MAX_ATTEMPTS) {
            await delayMs(EVENT_QUERY_RETRY_BASE_DELAY_MS * attempt);
        }
    }
    throw new Error(`Event query failed for ${eventType}: ${lastReason}`);
}

async function queryMoveEvents({ eventType, maxPages, pageSize }: QueryMoveEventsOptions): Promise<{
    events: unknown[];
    pagesRead: number;
    reachedLimit: boolean;
}> {
    const events: unknown[] = [];
    let cursor: unknown = null;
    for (let page = 0; page < maxPages; page += 1) {
        const payload = await fetchEventQueryPage(
            JSON.stringify({
                jsonrpc: "2.0",
                id: page + 1,
                method: "suix_queryEvents",
                params: [{ MoveEventType: eventType }, cursor, pageSize, true],
            }),
            eventType,
        );
        if (
            !isRecord(payload) ||
            !isRecord(payload.result) ||
            !Array.isArray(payload.result.data)
        ) {
            throw new Error(`Invalid event query response for ${eventType}`);
        }
        events.push(...payload.result.data);
        if (payload.result.hasNextPage !== true) {
            return { events, pagesRead: page + 1, reachedLimit: false };
        }
        cursor = payload.result.nextCursor;
    }
    return { events, pagesRead: maxPages, reachedLimit: true };
}

export async function queryPositionMintedEvents({
    trader,
    predictId,
    oracleId,
    expiryMs,
    strike,
    quoteCoinType,
}: {
    trader: string;
    predictId: string;
    oracleId: string;
    expiryMs: number;
    strike: bigint;
    quoteCoinType: string;
}): Promise<MintedPositionEvent[]> {
    const matches: MintedPositionEvent[] = [];
    const queried = await queryMoveEvents({
        eventType: POSITION_MINTED_EVENT_TYPE,
        maxPages: 20,
        pageSize: 50,
    });
    for (const event of queried.events) {
        let minted: MintedPositionEvent;
        try {
            minted = readPositionMintedEvent(event);
        } catch {
            continue;
        }
        if (
            minted.trader.toLowerCase() !== trader.toLowerCase() ||
            minted.predictId !== predictId ||
            minted.oracleId !== oracleId ||
            minted.expiryMs !== expiryMs ||
            minted.strike !== strike ||
            normalizeTypeName(minted.quoteAssetName) !== normalizeTypeName(quoteCoinType) ||
            minted.cost <= 0n ||
            minted.quantity <= 0n
        ) {
            continue;
        }
        matches.push(minted);
    }
    return matches;
}

export async function queryWalletPositionMintedEvents({
    trader,
    predictId,
    quoteCoinType,
    maxPages = 40,
    pageSize = 50,
}: {
    trader: string;
    predictId: string;
    quoteCoinType: string;
    maxPages?: number;
    pageSize?: number;
}): Promise<{ events: MintedPositionEvent[]; pagesRead: number; reachedLimit: boolean }> {
    const queried = await queryMoveEvents({
        eventType: POSITION_MINTED_EVENT_TYPE,
        maxPages,
        pageSize,
    });
    const events: MintedPositionEvent[] = [];
    for (const event of queried.events) {
        let minted: MintedPositionEvent;
        try {
            minted = readPositionMintedEvent(event);
        } catch {
            continue;
        }
        if (
            minted.trader.toLowerCase() !== trader.toLowerCase() ||
            minted.predictId !== predictId ||
            normalizeTypeName(minted.quoteAssetName) !== normalizeTypeName(quoteCoinType) ||
            minted.cost <= 0n ||
            minted.quantity <= 0n
        ) {
            continue;
        }
        events.push(minted);
    }
    return { events, pagesRead: queried.pagesRead, reachedLimit: queried.reachedLimit };
}

export async function queryWalletRangeMintedEvents({
    trader,
    predictId,
    quoteCoinType,
    maxPages = 40,
    pageSize = 50,
}: {
    trader: string;
    predictId: string;
    quoteCoinType: string;
    maxPages?: number;
    pageSize?: number;
}): Promise<{ events: RangeMintEvent[]; pagesRead: number; reachedLimit: boolean }> {
    const queried = await queryMoveEvents({
        eventType: RANGE_MINTED_EVENT_TYPE,
        maxPages,
        pageSize,
    });
    const events: RangeMintEvent[] = [];
    for (const event of queried.events) {
        let minted: RangeMintEvent;
        try {
            minted = readRangeMintedEvent([event]);
        } catch {
            continue;
        }
        if (
            minted.trader.toLowerCase() !== trader.toLowerCase() ||
            minted.predictId !== predictId ||
            normalizeTypeName(minted.quoteAssetName) !== normalizeTypeName(quoteCoinType) ||
            minted.cost <= 0n ||
            minted.quantity <= 0n
        ) {
            continue;
        }
        events.push(minted);
    }
    return { events, pagesRead: queried.pagesRead, reachedLimit: queried.reachedLimit };
}

export const POSITION_REDEEMED_EVENT_TYPE = `${PREDICT_BINARY_CONFIG.packageId}::predict::PositionRedeemed`;

export function readPositionRedeemedEvent(event: unknown): RedeemedPositionEvent {
    const payload = readSuiEventPayload(event);
    if (!payload) {
        throw new Error("PositionRedeemed event was not found");
    }
    return {
        managerId: readString(payload.manager_id, "manager_id"),
        oracleId: readString(payload.oracle_id, "oracle_id"),
        expiryMs: Number(readBigInt(payload.expiry, "expiry")),
        strike: readBigInt(payload.strike, "strike"),
        isUp: readBoolean(payload.is_up, "is_up"),
        quantity: readBigInt(payload.quantity, "quantity"),
        payout: readBigInt(payload.payout, "payout"),
        bidPrice: readBigInt(payload.bid_price, "bid_price"),
        isSettled: readBoolean(payload.is_settled, "is_settled"),
        digest: readEventDigest(event),
        timestampMs: readEventTimestampMs(event),
    };
}

export async function queryManagerPositionRedeemedEvents({
    managerId,
    maxPages = 40,
    pageSize = 50,
}: {
    managerId: string;
    maxPages?: number;
    pageSize?: number;
}): Promise<{ events: RedeemedPositionEvent[]; pagesRead: number; reachedLimit: boolean }> {
    const queried = await queryMoveEvents({
        eventType: POSITION_REDEEMED_EVENT_TYPE,
        maxPages,
        pageSize,
    });
    const events: RedeemedPositionEvent[] = [];
    for (const event of queried.events) {
        let redeemed: RedeemedPositionEvent;
        try {
            redeemed = readPositionRedeemedEvent(event);
        } catch {
            continue;
        }
        if (redeemed.managerId !== managerId) {
            continue;
        }
        events.push(redeemed);
    }
    return { events, pagesRead: queried.pagesRead, reachedLimit: queried.reachedLimit };
}

export function readRedeemEvent(events: SuiClientTypes.Event[] | undefined): RedeemEvent {
    const event = events?.find(
        (item) =>
            item.eventType === `${PREDICT_BINARY_CONFIG.packageId}::predict::PositionRedeemed`,
    );
    const payload = readSuiEventPayload(event);
    if (!payload) {
        throw new Error("PositionRedeemed event was not found");
    }
    return {
        managerId: readString(payload.manager_id, "manager_id"),
        oracleId: readString(payload.oracle_id, "oracle_id"),
        expiryMs: Number(readBigInt(payload.expiry, "expiry")),
        strike: readBigInt(payload.strike, "strike"),
        isUp: readBoolean(payload.is_up, "is_up"),
        quantity: readBigInt(payload.quantity, "quantity"),
        payout: readBigInt(payload.payout, "payout"),
        bidPrice: readBigInt(payload.bid_price, "bid_price"),
        isSettled: readBoolean(payload.is_settled, "is_settled"),
    };
}

export function readDigest(result: unknown): string {
    return readTransactionDigest(result);
}
