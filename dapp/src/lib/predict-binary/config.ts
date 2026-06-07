import { deepArenaMockConfig } from "@/src/lib/deep-arena/config";

export const PREDICT_BINARY_CONFIG = {
    network: "testnet",
    packageId: deepArenaMockConfig.predictPackageId,
    registryId: deepArenaMockConfig.predictRegistryId,
    predictObjectId: deepArenaMockConfig.predictObjectId,
    predictServerUrl: deepArenaMockConfig.predictServerUrl,
    quoteCoinType: deepArenaMockConfig.quoteCoinType,
    quoteDecimals: deepArenaMockConfig.quoteDecimals,
    quoteSymbol: deepArenaMockConfig.quoteSymbol,
    underlyingAsset: "BTC",
    clockObjectId: "0x6",
    priceScale: 1_000_000_000n,
    quantityUnit: 1_000_000n,
    fullnodeJsonRpcUrl: "https://fullnode.testnet.sui.io",
} as const;

export function predictBinaryExplorerUrl(digest: string): string {
    return `https://suiexplorer.com/txblock/${digest}?network=testnet`;
}
