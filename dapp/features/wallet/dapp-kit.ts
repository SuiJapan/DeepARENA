import { createDAppKit, type StateStorage } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";

const GRPC_URLS = {
    testnet: "https://fullnode.testnet.sui.io:443",
} as const;

const fallbackStorage = new Map<string, string>();

function getBrowserStorage(): Storage | null {
    if (typeof window === "undefined") {
        return null;
    }
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

const storage: StateStorage = {
    getItem: (key) => getBrowserStorage()?.getItem(key) ?? fallbackStorage.get(key) ?? null,
    setItem: (key, value) => {
        const browserStorage = getBrowserStorage();
        if (browserStorage) {
            browserStorage.setItem(key, value);
            return;
        }
        fallbackStorage.set(key, value);
    },
    removeItem: (key) => {
        const browserStorage = getBrowserStorage();
        if (browserStorage) {
            browserStorage.removeItem(key);
            return;
        }
        fallbackStorage.delete(key);
    },
};

export const dAppKit = createDAppKit({
    networks: ["testnet"],
    createClient: (network: keyof typeof GRPC_URLS) =>
        new SuiGrpcClient({ network, baseUrl: GRPC_URLS[network] }),
    storage,
});

declare module "@mysten/dapp-kit-react" {
    interface Register {
        dAppKit: typeof dAppKit;
    }
}
