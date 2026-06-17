import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { PREDICT_BINARY_CONFIG } from "./config.ts";

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
 * mintCost + fee に 10% スリッページバッファを加算して切り上げる。
 * preview とウォレット承認の間に ask 価格が動くため、バッファが小さいと
 * mint 内部の出金が残高不足で abort する（実測で数分間に ±13% の変動を確認）。
 * 超過入金分は manager に残り、Portfolio の Collect ボタンで回収できる。
 */
export function calcMaxTotalCost(mintCost: bigint, feeBps: number): bigint {
    const fee = calcFee(mintCost, feeBps);
    const base = mintCost + fee;
    return base + (base + 9n) / 10n; // +10% buffer (round up)
}

/**
 * 入金可能額(depositCapacity = ウォレット残高 + マネージャー残高)に収まる
 * 最大の掛け金(mintCost 目標)を求める。
 * calcMaxTotalCost(stake) <= depositCapacity を満たす最大 stake を二分探索する。
 * 入力を「上限」ではなく「目標」として扱う際、残高超過で BET が失敗しないよう
 * 目標額を自動的に引き下げるために使う。
 */
export function maxStakeWithinDeposit(depositCapacity: bigint, feeBps: number): bigint {
    if (depositCapacity <= 0n) {
        return 0n;
    }
    // calcMaxTotalCost(stake) >= stake なので、上限は depositCapacity で十分。
    let low = 0n;
    let high = depositCapacity;
    while (low < high) {
        const mid = (low + high + 1n) / 2n;
        if (calcMaxTotalCost(mid, feeBps) <= depositCapacity) {
            low = mid;
        } else {
            high = mid - 1n;
        }
    }
    return low;
}

export interface BinaryMarketKeyInput {
    oracleId: string;
    expiryMs: number;
    strike: bigint;
    isUp: boolean;
}

export interface BatchBinaryPreviewInput {
    key: BinaryMarketKeyInput;
    quantity: bigint;
}

export interface BatchRangePreviewInput {
    key: RangeKeyInput;
    quantity: bigint;
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

export interface RedeemRangeTransactionInput extends RangeKeyInput {
    sender: string;
    managerId: string;
    quantity: bigint;
}

export interface RedeemBreakTransactionInput extends RangeKeyInput {
    sender: string;
    managerId: string;
    quantity: bigint;
}

export type CollectClaimInput =
    | ({ kind: "binary" } & RedeemBinaryTransactionInput)
    | ({ kind: "range" } & RedeemRangeTransactionInput);

export interface CollectManagerBalanceInput {
    managerId: string;
    amount: bigint;
}

export interface CollectPayoutsTransactionInput {
    sender: string;
    claims: CollectClaimInput[];
    managerBalances: CollectManagerBalanceInput[];
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

export function createBatchPreviewTransaction({
    sender,
    inputs,
}: {
    sender: string;
    inputs: BatchBinaryPreviewInput[];
}): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    for (const input of inputs) {
        const key = addMarketKey(tx, input.key);
        tx.moveCall({
            target: target("predict", "get_trade_amounts"),
            arguments: [
                tx.object(PREDICT_BINARY_CONFIG.predictObjectId),
                tx.object(input.key.oracleId),
                key,
                tx.pure.u64(input.quantity),
                tx.object(PREDICT_BINARY_CONFIG.clockObjectId),
            ],
        });
    }
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

export function createReadAskBoundsTransaction({
    sender,
    oracleId,
}: {
    sender: string;
    oracleId: string;
}): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    tx.moveCall({
        target: target("predict", "ask_bounds"),
        arguments: [tx.object(PREDICT_BINARY_CONFIG.predictObjectId), tx.pure.id(oracleId)],
    });
    return tx;
}

export function createReadRangePositionTransaction({
    sender,
    managerId,
    ...range
}: RangeKeyInput & {
    sender: string;
    managerId: string;
}): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    const key = addRangeKey(tx, range);
    tx.moveCall({
        target: target("predict_manager", "range_position"),
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

export function createBatchRangePreviewTransaction({
    sender,
    inputs,
}: {
    sender: string;
    inputs: BatchRangePreviewInput[];
}): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    for (const input of inputs) {
        const key = addRangeKey(tx, input.key);
        tx.moveCall({
            target: target("predict", "get_range_trade_amounts"),
            arguments: [
                tx.object(PREDICT_BINARY_CONFIG.predictObjectId),
                tx.object(input.key.oracleId),
                key,
                tx.pure.u64(input.quantity),
                tx.object(PREDICT_BINARY_CONFIG.clockObjectId),
            ],
        });
    }
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
            tx.pure.u64(
                input.lowerQuantity < input.upperQuantity
                    ? input.lowerQuantity
                    : input.upperQuantity,
            ),
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
    // DeepARENA の bet::claim_binary 経由で redeem する。
    // これにより payout が PnL スコア（cumulative_payout）と Top キャッシュに反映される。
    // claim_binary が内部で permissionless redeem を行い payout を manager 残高へ入れる。
    const tx = new Transaction();
    tx.setSender(input.sender);
    tx.moveCall({
        target: arenaTarget("bet", "claim_binary"),
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
            tx.object(PREDICT_BINARY_CONFIG.clockObjectId),
        ],
    });
    return tx;
}

export function createClaimBinaryPayoutTransaction(
    input: RedeemBinaryTransactionInput,
): Transaction {
    // Collect ボタン: DeepARENA bet::claim_binary で redeem（payout を PnL/Top キャッシュへ反映）
    // → manager から payout 分を withdraw → wallet へ transfer。
    const tx = new Transaction();
    tx.setSender(input.sender);
    tx.moveCall({
        target: arenaTarget("bet", "claim_binary"),
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

export function createClaimRangePayoutTransaction(input: RedeemRangeTransactionInput): Transaction {
    const tx = new Transaction();
    tx.setSender(input.sender);
    tx.moveCall({
        target: arenaTarget("bet", "claim_range"),
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

export function createClaimBreakPayoutTransaction(input: RedeemBreakTransactionInput): Transaction {
    const tx = new Transaction();
    tx.setSender(input.sender);
    tx.moveCall({
        target: arenaTarget("bet", "claim_break"),
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

export function createCollectPayoutsTransaction(
    input: CollectPayoutsTransactionInput,
): Transaction {
    const tx = new Transaction();
    tx.setSender(input.sender);

    for (const claim of input.claims) {
        if (claim.kind === "binary") {
            tx.moveCall({
                target: arenaTarget("bet", "claim_binary"),
                typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
                arguments: [
                    tx.object(PREDICT_BINARY_CONFIG.arenaObjectId),
                    tx.object(PREDICT_BINARY_CONFIG.predictObjectId),
                    tx.object(claim.managerId),
                    tx.object(claim.oracleId),
                    tx.pure.id(claim.oracleId),
                    tx.pure.u64(claim.expiryMs),
                    tx.pure.u64(claim.strike),
                    tx.pure.bool(claim.isUp),
                    tx.pure.u64(claim.quantity),
                    tx.object(PREDICT_BINARY_CONFIG.clockObjectId),
                ],
            });
        } else {
            tx.moveCall({
                target: arenaTarget("bet", "claim_range"),
                typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
                arguments: [
                    tx.object(PREDICT_BINARY_CONFIG.arenaObjectId),
                    tx.object(PREDICT_BINARY_CONFIG.predictObjectId),
                    tx.object(claim.managerId),
                    tx.object(claim.oracleId),
                    tx.pure.id(claim.oracleId),
                    tx.pure.u64(claim.expiryMs),
                    tx.pure.u64(claim.lowerStrike),
                    tx.pure.u64(claim.higherStrike),
                    tx.pure.u64(claim.quantity),
                    tx.object(PREDICT_BINARY_CONFIG.clockObjectId),
                ],
            });
        }

        const payoutCoin = tx.moveCall({
            target: target("predict_manager", "withdraw"),
            typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
            arguments: [tx.object(claim.managerId), tx.pure.u64(claim.quantity)],
        });
        tx.transferObjects([payoutCoin], input.sender);
    }

    for (const balance of input.managerBalances) {
        const coin = tx.moveCall({
            target: target("predict_manager", "withdraw"),
            typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
            arguments: [tx.object(balance.managerId), tx.pure.u64(balance.amount)],
        });
        tx.transferObjects([coin], input.sender);
    }

    return tx;
}

export function describeClaimBinaryPayoutMoveCalls(): MoveCallSummary[] {
    return [
        {
            target: arenaTarget("bet", "claim_binary"),
            typeArguments: [PREDICT_BINARY_CONFIG.quoteCoinType],
            purpose: "claim winning Binary via DeepARENA (updates PnL) into PredictManager balance",
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
