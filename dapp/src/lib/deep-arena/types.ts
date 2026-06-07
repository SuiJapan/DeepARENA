export type ObjectId = string;
export type SuiAddress = string;
export type AtomicAmount = string;

export interface TokenAmount {
    atomic: AtomicAmount;
    decimals: number;
    symbol: string;
}

export type ArenaStatus = "upcoming" | "active" | "settled";
export type OracleStatus = "inactive" | "active" | "pending-settlement" | "settled";

export interface ArenaSummary {
    id: ObjectId;
    name: string;
    status: ArenaStatus;
    startMs: number;
    endMs: number;
    participantCount: number;
    prizePool: TokenAmount;
    entryAmount: TokenAmount;
    quoteCoinType: string;
    predictObjectId: ObjectId;
}

export interface PlayerSummary {
    address: SuiAddress;
    displayName: string;
    rank: number;
    score: TokenAmount;
    deposited: TokenAmount;
    predictManagerId: ObjectId;
    isCurrentPlayer: boolean;
}

export interface MarketKey {
    oracleId: ObjectId;
    expiryMs: number;
    strike: string;
    isUp: boolean;
}

export interface RangeKey {
    oracleId: ObjectId;
    expiryMs: number;
    lowerStrike: string;
    higherStrike: string;
}

export interface BinaryMarket {
    id: string;
    label: string;
    underlying: string;
    key: MarketKey;
    oracleStatus: OracleStatus;
    markPrice: string;
    openInterest: TokenAmount;
}

export interface RangeMarket {
    id: string;
    label: string;
    underlying: string;
    key: RangeKey;
    oracleStatus: OracleStatus;
    markPrice: string;
    openInterest: TokenAmount;
}

export interface VaultState {
    quoteAsset: string;
    availableLiquidity: TokenAmount;
    markToMarketLiability: TokenAmount;
    maximumPayout: TokenAmount;
    utilizationPercent: string;
}

export interface PlpState {
    coinType: string;
    totalSupply: string;
    priceInQuote: string;
    dayChangePercent: string;
}

export type EventKind =
    | "arena-created"
    | "player-joined"
    | "binary-opened"
    | "range-opened"
    | "liquidity-provided"
    | "score-updated";

export interface EventLog {
    id: string;
    kind: EventKind;
    title: string;
    detail: string;
    actor: SuiAddress;
    timestampMs: number;
    isMock: boolean;
}

export type ActionKind = "binary" | "range";

export interface ActionPreview {
    kind: ActionKind;
    marketId: string;
    marketLabel: string;
    quantity: string;
    estimatedCost: TokenAmount;
    estimatedPayout: TokenAmount;
    fee: TokenAmount;
    warning: string;
}

export interface BinaryActionInput {
    marketId: string;
    quantity: string;
}

export interface RangeActionInput {
    marketId: string;
    quantity: string;
}

export interface MockActionResult {
    preview: ActionPreview;
    arena: ArenaSummary;
    player: PlayerSummary;
    event: EventLog;
}

export interface DeepArenaSnapshot {
    arena: ArenaSummary;
    players: PlayerSummary[];
    binaryMarkets: BinaryMarket[];
    rangeMarkets: RangeMarket[];
    vault: VaultState;
    plp: PlpState;
    events: EventLog[];
}
