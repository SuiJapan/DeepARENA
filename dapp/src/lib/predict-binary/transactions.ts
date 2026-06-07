import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { PREDICT_BINARY_CONFIG } from "./config";

export interface BinaryMarketKeyInput {
    oracleId: string;
    expiryMs: number;
    strike: bigint;
    isUp: boolean;
}

export interface MintBinaryTransactionInput extends BinaryMarketKeyInput {
    sender: string;
    managerId: string;
    quantity: bigint;
    depositAmount: bigint;
}

export interface RedeemBinaryTransactionInput extends BinaryMarketKeyInput {
    sender: string;
    managerId: string;
    quantity: bigint;
}

export interface MoveCallSummary {
    target: string;
    typeArguments: string[];
    purpose: string;
}

export const target = (moduleName: string, functionName: string) =>
    `${PREDICT_BINARY_CONFIG.packageId}::${moduleName}::${functionName}`;

function addMarketKey(tx: Transaction, market: BinaryMarketKeyInput) {
    return tx.moveCall({
        target: target("market_key", "new"),
        arguments: [
            tx.pure.id(market.oracleId),
            tx.pure.u64(market.expiryMs),
            tx.pure.u64(market.strike),
            tx.pure.bool(market.isUp),
        ],
    });
}

export function createPredictManagerTransaction(sender: string): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    tx.moveCall({ target: target("predict", "create_manager") });
    return tx;
}

export function describeCreatePredictManagerMoveCalls(): MoveCallSummary[] {
    return [
        {
            target: target("predict", "create_manager"),
            typeArguments: [],
            purpose: "create PredictManager",
        },
    ];
}

export function createPreviewTradeAmountsTransaction({
    sender,
    quantity,
    ...market
}: BinaryMarketKeyInput & { sender: string; quantity: bigint }): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    const key = addMarketKey(tx, market);
    tx.moveCall({
        target: target("predict", "get_trade_amounts"),
        arguments: [
            tx.object(PREDICT_BINARY_CONFIG.predictObjectId),
            tx.object(market.oracleId),
            key,
            tx.pure.u64(quantity),
            tx.object(PREDICT_BINARY_CONFIG.clockObjectId),
        ],
    });
    return tx;
}

export function createReadManagerBalanceTransaction({
    sender,
    managerId,
}: {
    sender: string;
    managerId: string;
}): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    tx.moveCall({
        target: target("predict_manager", "balance"),
        typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
        arguments: [tx.object(managerId)],
    });
    return tx;
}

export function createReadBinaryPositionTransaction({
    sender,
    managerId,
    ...market
}: BinaryMarketKeyInput & {
    sender: string;
    managerId: string;
}): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    const key = addMarketKey(tx, market);
    tx.moveCall({
        target: target("predict_manager", "position"),
        arguments: [tx.object(managerId), key],
    });
    return tx;
}

export function createMintBinaryTransaction(input: MintBinaryTransactionInput): Transaction {
    const tx = new Transaction();
    tx.setSender(input.sender);

    if (input.depositAmount > 0n) {
        const depositCoin = coinWithBalance({
            balance: input.depositAmount,
            type: PREDICT_BINARY_CONFIG.quoteCoinType,
        });
        tx.moveCall({
            target: target("predict_manager", "deposit"),
            typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
            arguments: [tx.object(input.managerId), depositCoin],
        });
    }

    const key = addMarketKey(tx, input);
    tx.moveCall({
        target: target("predict", "mint"),
        typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
        arguments: [
            tx.object(PREDICT_BINARY_CONFIG.predictObjectId),
            tx.object(input.managerId),
            tx.object(input.oracleId),
            key,
            tx.pure.u64(input.quantity),
            tx.object(PREDICT_BINARY_CONFIG.clockObjectId),
        ],
    });

    return tx;
}

export function describeMintBinaryMoveCalls(input: MintBinaryTransactionInput): MoveCallSummary[] {
    const calls: MoveCallSummary[] = [];
    if (input.depositAmount > 0n) {
        calls.push({
            target: target("predict_manager", "deposit"),
            typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
            purpose: "deposit DUSDC shortfall into PredictManager",
        });
    }
    calls.push(
        {
            target: target("market_key", "new"),
            typeArguments: [],
            purpose: "build Binary MarketKey",
        },
        {
            target: target("predict", "mint"),
            typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
            purpose: "mint Binary position",
        },
    );
    return calls;
}

export function createRedeemBinaryTransaction(input: RedeemBinaryTransactionInput): Transaction {
    const tx = new Transaction();
    tx.setSender(input.sender);
    const key = addMarketKey(tx, input);
    tx.moveCall({
        target: target("predict", "redeem_permissionless"),
        typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
        arguments: [
            tx.object(PREDICT_BINARY_CONFIG.predictObjectId),
            tx.object(input.managerId),
            tx.object(input.oracleId),
            key,
            tx.pure.u64(input.quantity),
            tx.object(PREDICT_BINARY_CONFIG.clockObjectId),
        ],
    });
    return tx;
}

export function createWithdrawManagerQuoteTransaction({
    sender,
    managerId,
    amount,
}: {
    sender: string;
    managerId: string;
    amount: bigint;
}): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    const coin = tx.moveCall({
        target: target("predict_manager", "withdraw"),
        typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
        arguments: [tx.object(managerId), tx.pure.u64(amount)],
    });
    tx.transferObjects([coin], sender);
    return tx;
}
