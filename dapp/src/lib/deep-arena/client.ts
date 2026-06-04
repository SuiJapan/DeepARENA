import type {
    ActionPreview,
    ArenaSummary,
    BinaryActionInput,
    BinaryMarket,
    EventLog,
    MockActionResult,
    PlayerSummary,
    PlpState,
    RangeActionInput,
    RangeMarket,
    VaultState,
} from "./types";

export interface DeepArenaClient {
    getArena(): Promise<ArenaSummary>;
    listPlayers(): Promise<PlayerSummary[]>;
    listBinaryMarkets(): Promise<BinaryMarket[]>;
    listRangeMarkets(): Promise<RangeMarket[]>;
    previewBinary(input: BinaryActionInput): Promise<ActionPreview>;
    openBinaryMock(input: BinaryActionInput): Promise<MockActionResult>;
    previewRange(input: RangeActionInput): Promise<ActionPreview>;
    openRangeMock(input: RangeActionInput): Promise<MockActionResult>;
    getVaultState(): Promise<VaultState>;
    getPlpState(): Promise<PlpState>;
    listEvents(): Promise<EventLog[]>;
}
