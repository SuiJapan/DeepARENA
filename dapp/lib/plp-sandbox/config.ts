import { deepArenaMockConfig } from "@/lib/deep-arena/config";

export const PLP_SANDBOX_CONFIG = {
    network: "testnet",
    sandboxPackageId: process.env.NEXT_PUBLIC_PLP_SANDBOX_PACKAGE_ID ?? "",
    predictPackageId: deepArenaMockConfig.predictPackageId,
    predictObjectId: deepArenaMockConfig.predictObjectId,
    dusdcCoinType: deepArenaMockConfig.quoteCoinType,
    dusdcDecimals: deepArenaMockConfig.quoteDecimals,
    plpCoinType: deepArenaMockConfig.plpCoinType,
    plpDecimals: deepArenaMockConfig.quoteDecimals,
    clockObjectId: "0x6",
} as const;

export function hasPlpSandboxPackageId(): boolean {
    return PLP_SANDBOX_CONFIG.sandboxPackageId.startsWith("0x");
}

export function plpSandboxExplorerUrl(digest: string): string {
    return `https://suiexplorer.com/txblock/${digest}?network=testnet`;
}

export function plpSandboxSuiScanPlpUrl(): string {
    return `https://suiscan.xyz/testnet/coin/${PLP_SANDBOX_CONFIG.plpCoinType}/txs`;
}
