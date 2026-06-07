import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { PLP_SANDBOX_CONFIG } from "./config";

export type PlpSandboxAction = "supply" | "withdraw";

export function createPlpSandboxTransaction({
    action,
    amount,
    sender,
}: {
    action: PlpSandboxAction;
    amount: bigint;
    sender: string;
}): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);

    const coin =
        action === "supply"
            ? coinWithBalance({ balance: amount, type: PLP_SANDBOX_CONFIG.dusdcCoinType })
            : coinWithBalance({ balance: amount, type: PLP_SANDBOX_CONFIG.plpCoinType });

    const returnedCoin = tx.moveCall({
        target:
            action === "supply"
                ? `${PLP_SANDBOX_CONFIG.sandboxPackageId}::plp_sandbox::provide_liquidity`
                : `${PLP_SANDBOX_CONFIG.sandboxPackageId}::plp_sandbox::withdraw_liquidity`,
        typeArguments: [PLP_SANDBOX_CONFIG.dusdcCoinType],
        arguments: [
            tx.object(PLP_SANDBOX_CONFIG.predictObjectId),
            coin,
            tx.object(PLP_SANDBOX_CONFIG.clockObjectId),
        ],
    });
    tx.transferObjects([returnedCoin], sender);

    return tx;
}
