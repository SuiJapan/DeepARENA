import type { DeepArenaClient } from "./client";
import { deepArenaMockConfig } from "./config";
import { ContractDeepArenaClient } from "./contract-client";
import { createMockDeepArenaClient } from "./mock-client";

/**
 * NEXT_PUBLIC_DEEP_ARENA_NETWORK=contract → ContractDeepArenaClient (reads Sui testnet)
 * default → MockDeepArenaClient
 */
export function createDeepArenaClient(): DeepArenaClient {
    if (process.env.NEXT_PUBLIC_DEEP_ARENA_NETWORK === "contract") {
        return new ContractDeepArenaClient(deepArenaMockConfig);
    }
    return createMockDeepArenaClient();
}
