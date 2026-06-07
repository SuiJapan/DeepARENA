import type { DeepArenaClient } from "./client";

function notImplemented(): never {
    throw new Error(
        "Contract client is not implemented. Use the mock client until the Move ABI is finalized.",
    );
}

export class ContractDeepArenaClient implements DeepArenaClient {
    // TODO: arena - map the finalized shared object reads into ArenaSummary and PlayerSummary.
    // TODO: binary/range - map finalized preview and transaction inputs without assuming entry names.
    // TODO: predict_adapter - connect Predict object, manager, oracle, vault, and PLP boundaries.
    // TODO: events - query finalized event types and normalize them into EventLog.
    // Package IDs, object IDs, entry names, and argument order intentionally remain undefined.

    async getArena() {
        return notImplemented();
    }

    async listPlayers() {
        return notImplemented();
    }

    async listBinaryMarkets() {
        return notImplemented();
    }

    async listRangeMarkets() {
        return notImplemented();
    }

    async previewBinary() {
        return notImplemented();
    }

    async openBinaryMock() {
        return notImplemented();
    }

    async previewRange() {
        return notImplemented();
    }

    async openRangeMock() {
        return notImplemented();
    }

    async getVaultState() {
        return notImplemented();
    }

    async getPlpState() {
        return notImplemented();
    }

    async listEvents() {
        return notImplemented();
    }
}
