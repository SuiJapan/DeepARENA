import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { PREDICT_BINARY_CONFIG } from "./config";

/** Deep Arena パッケージ内の関数ターゲットを返す */
const arenaTarget = (moduleName: string, functionName: string) =>
    `${PREDICT_BINARY_CONFIG.deepArenaPackageId}::${moduleName}::${functionName}`;

/**
 * mintCost（推定コスト）から手数料を切り上げ計算する。
 * fee = ceil(mintCost * feeBps / 10_000)
 */
export function calcFee(mintCost: bigint, feeBps: number): bigint {
    return (mintCost * BigInt(feeBps) + 9_999n) / 10_000n;
}

/**
 * maxTotalCost を計算する。
 * mintCost + fee に 1% スリッページバッファを加算して切り上げる。
 */
export function calcMaxTotalCost(mintCost: bigint, feeBps: number): bigint {
    const fee = calcFee(mintCost, feeBps);
    const base = mintCost + fee;
    return base + (base + 99n) / 100n; // +1% buffer (round up)
}

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
    maxTotalCost: bigint;
}

export interface RedeemBinaryTransactionInput extends BinaryMarketKeyInput {
    sender: string;
    managerId: string;
    quantity: bigint;
}

export interface RangeKeyInput {
    oracleId: string;
    expiryMs: number;
    lowerStrike: bigint;
    higherStrike: bigint;
}

export interface MintRangeTransactionInput extends RangeKeyInput {
    sender: string;
    managerId: string;
    quantity: bigint;
    depositAmount: bigint;
    maxTotalCost: bigint;
}

export interface MintBreakTransactionInput extends RangeKeyInput {
    sender: string;
    managerId: string;
    lowerQuantity: bigint;
    upperQuantity: bigint;
    depositAmount: bigint;
    maxTotalCost: bigint;
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

function addRangeKey(tx: Transaction, range: RangeKeyInput) {
    return tx.moveCall({
        target: target("range_key", "new"),
        arguments: [
            tx.pure.id(range.oracleId),
            tx.pure.u64(range.expiryMs),
            tx.pure.u64(range.lowerStrike),
            tx.pure.u64(range.higherStrike),
        ],
    });
}

export function createPredictManagerTransaction(sender: string): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    tx.moveCall({ target: target("predict", "create_manager") });
    return tx;
}

/** Arena への参加登録 PTB（初回 BET 前に 1 回だけ実行） */
export function createJoinArenaTransaction({
    sender,
    managerId,
}: {
    sender: string;
    managerId: string;
}): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    tx.moveCall({
        target: arenaTarget("arena", "join_arena"),
        typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
        arguments: [
            tx.object(PREDICT_BINARY_CONFIG.arenaObjectId),
            tx.object(managerId),
            tx.object(PREDICT_BINARY_CONFIG.clockObjectId),
        ],
    });
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

export function createPreviewRangeTradeAmountsTransaction({
    sender,
    quantity,
    ...range
}: RangeKeyInput & { sender: string; quantity: bigint }): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    const key = addRangeKey(tx, range);
    tx.moveCall({
        target: target("predict", "get_range_trade_amounts"),
        arguments: [
            tx.object(PREDICT_BINARY_CONFIG.predictObjectId),
            tx.object(range.oracleId),
            key,
            tx.pure.u64(quantity),
            tx.object(PREDICT_BINARY_CONFIG.clockObjectId),
        ],
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

    tx.moveCall({
        target: arenaTarget("bet", "open_binary"),
        typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
        arguments: [
            tx.object(PREDICT_BINARY_CONFIG.arenaObjectId),
            tx.object(PREDICT_BINARY_CONFIG.predictObjectId),
            tx.object(input.managerId),
            tx.object(input.oracleId),
            tx.pure.id(input.oracleId),
            tx.pure.u64(input.expiryMs),
            tx.pure.u64(input.strike),
            tx.pure.bool(input.isUp),
            tx.pure.u64(input.quantity),
            tx.pure.u64(input.maxTotalCost),
            tx.object(PREDICT_BINARY_CONFIG.clockObjectId),
        ],
    });

    return tx;
}

export function createMintRangeTransaction(input: MintRangeTransactionInput): Transaction {
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

    tx.moveCall({
        target: arenaTarget("bet", "open_range"),
        typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
        arguments: [
            tx.object(PREDICT_BINARY_CONFIG.arenaObjectId),
            tx.object(PREDICT_BINARY_CONFIG.predictObjectId),
            tx.object(input.managerId),
            tx.object(input.oracleId),
            tx.pure.id(input.oracleId),
            tx.pure.u64(input.expiryMs),
            tx.pure.u64(input.lowerStrike),
            tx.pure.u64(input.higherStrike),
            tx.pure.u64(input.quantity),
            tx.pure.u64(input.maxTotalCost),
            tx.object(PREDICT_BINARY_CONFIG.clockObjectId),
        ],
    });

    return tx;
}

export function createMintBreakTransaction(input: MintBreakTransactionInput): Transaction {
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

    tx.moveCall({
        target: arenaTarget("bet", "open_break"),
        typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
        arguments: [
            tx.object(PREDICT_BINARY_CONFIG.arenaObjectId),
            tx.object(PREDICT_BINARY_CONFIG.predictObjectId),
            tx.object(input.managerId),
            tx.object(input.oracleId),
            tx.pure.id(input.oracleId),
            tx.pure.u64(input.expiryMs),
            tx.pure.u64(input.lowerStrike),
            tx.pure.u64(input.higherStrike),
            tx.pure.u64(input.lowerQuantity),
            tx.pure.u64(input.maxTotalCost),
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

export function describeMintRangeMoveCalls(input: MintRangeTransactionInput): MoveCallSummary[] {
    const calls: MoveCallSummary[] = [];
    if (input.depositAmount > 0n) {
        calls.push({
            target: target("predict_manager", "deposit"),
            typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
            purpose: "deposit DUSDC for Range mint",
        });
    }
    calls.push(
        {
            target: target("range_key", "new"),
            typeArguments: [],
            purpose: "build RangeKey",
        },
        {
            target: target("predict", "mint_range"),
            typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
            purpose: "mint Range position",
        },
    );
    return calls;
}

export function describeMintBreakMoveCalls(input: MintBreakTransactionInput): MoveCallSummary[] {
    const calls: MoveCallSummary[] = [];
    if (input.depositAmount > 0n) {
        calls.push({
            target: target("predict_manager", "deposit"),
            typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
            purpose: "deposit DUSDC for two-leg Break mint",
        });
    }
    calls.push(
        {
            target: target("market_key", "new"),
            typeArguments: [],
            purpose: "build lower DOWN MarketKey",
        },
        {
            target: target("predict", "mint"),
            typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
            purpose: "mint lower break DOWN leg",
        },
        {
            target: target("market_key", "new"),
            typeArguments: [],
            purpose: "build upper UP MarketKey",
        },
        {
            target: target("predict", "mint"),
            typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
            purpose: "mint upper break UP leg",
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

export function createClaimBinaryPayoutTransaction(
    input: RedeemBinaryTransactionInput,
): Transaction {
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
    const coin = tx.moveCall({
        target: target("predict_manager", "withdraw"),
        typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
        arguments: [tx.object(input.managerId), tx.pure.u64(input.quantity)],
    });
    tx.transferObjects([coin], input.sender);
    return tx;
}

export function describeClaimBinaryPayoutMoveCalls(): MoveCallSummary[] {
    return [
        {
            target: target("market_key", "new"),
            typeArguments: [],
            purpose: "build Binary MarketKey",
        },
        {
            target: target("predict", "redeem_permissionless"),
            typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
            purpose: "redeem winning Binary position into PredictManager balance",
        },
        {
            target: target("predict_manager", "withdraw"),
            typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
            purpose: "withdraw redeemed DUSDC from PredictManager",
        },
        {
            target: "transferObjects",
            typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
            purpose: "transfer withdrawn DUSDC to wallet",
        },
    ];
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
