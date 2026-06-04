export type DeepArenaNetwork = "testnet" | "mock";

export interface DeepArenaConfig {
    network: DeepArenaNetwork;
    predictPackageId: string;
    predictRegistryId: string;
    predictObjectId: string;
    quoteCoinType: string;
    quoteSymbol: string;
    quoteDecimals: number;
    plpCoinType: string;
    predictServerUrl: string;
}

// Mock dashboard configuration based on the current Predict testnet documentation.
// These values are not an approved production deployment or a guarantee of trade availability.
export const deepArenaMockConfig: DeepArenaConfig = {
    network: "mock",
    predictPackageId: "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138",
    predictRegistryId: "0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64",
    predictObjectId: "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a",
    quoteCoinType:
        "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC",
    quoteSymbol: "DUSDC",
    quoteDecimals: 6,
    plpCoinType: "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138::plp::PLP",
    predictServerUrl: "https://predict-server.testnet.mystenlabs.com",
};
