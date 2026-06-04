import type { DeepArenaClient } from "./client";
import { deepArenaMockConfig } from "./config";
import { normalizeActionPreview, normalizeEventLog, normalizeQuantity } from "./normalize";
import type {
    ActionPreview,
    ArenaSummary,
    BinaryActionInput,
    BinaryMarket,
    EventKind,
    EventLog,
    MockActionResult,
    PlayerSummary,
    PlpState,
    RangeActionInput,
    RangeMarket,
    TokenAmount,
    VaultState,
} from "./types";

const quote = (atomic: string): TokenAmount => ({
    atomic,
    decimals: deepArenaMockConfig.quoteDecimals,
    symbol: deepArenaMockConfig.quoteSymbol,
});

const currentPlayerAddress = "0x8f2a...91ce";
const mockExpiryMs = 1790812800000;

const binaryMarkets: BinaryMarket[] = [
    {
        id: "binary-sui-4-up",
        label: "SUI above 4.00",
        underlying: "SUI / DUSDC",
        key: { oracleId: "0xoracle-sui", expiryMs: mockExpiryMs, strike: "4.00", isUp: true },
        oracleStatus: "active",
        markPrice: "0.61",
        openInterest: quote("82400000000"),
    },
    {
        id: "binary-sui-5-up",
        label: "SUI above 5.00",
        underlying: "SUI / DUSDC",
        key: { oracleId: "0xoracle-sui", expiryMs: mockExpiryMs, strike: "5.00", isUp: true },
        oracleStatus: "active",
        markPrice: "0.43",
        openInterest: quote("51750000000"),
    },
];

const rangeMarkets: RangeMarket[] = [
    {
        id: "range-sui-3-4",
        label: "SUI 3.00 - 4.00",
        underlying: "SUI / DUSDC",
        key: {
            oracleId: "0xoracle-sui",
            expiryMs: mockExpiryMs,
            lowerStrike: "3.00",
            higherStrike: "4.00",
        },
        oracleStatus: "active",
        markPrice: "0.37",
        openInterest: quote("46300000000"),
    },
    {
        id: "range-sui-4-6",
        label: "SUI 4.00 - 6.00",
        underlying: "SUI / DUSDC",
        key: {
            oracleId: "0xoracle-sui",
            expiryMs: mockExpiryMs,
            lowerStrike: "4.00",
            higherStrike: "6.00",
        },
        oracleStatus: "active",
        markPrice: "0.54",
        openInterest: quote("28900000000"),
    },
];

const initialArena: ArenaSummary = {
    id: "0xarena-mock-001",
    name: "Genesis Forecast Sprint",
    status: "active",
    startMs: 1769904000000,
    endMs: mockExpiryMs,
    participantCount: 24,
    prizePool: quote("12000000000"),
    entryAmount: quote("500000000"),
    quoteCoinType: deepArenaMockConfig.quoteCoinType,
    predictObjectId: deepArenaMockConfig.predictObjectId,
};

const initialPlayers: PlayerSummary[] = [
    {
        address: currentPlayerAddress,
        displayName: "You",
        rank: 3,
        score: quote("1248200000"),
        deposited: quote("500000000"),
        predictManagerId: "0xmanager-current",
        isCurrentPlayer: true,
    },
    {
        address: "0x72de...4a10",
        displayName: "Quant Tide",
        rank: 1,
        score: quote("1876500000"),
        deposited: quote("500000000"),
        predictManagerId: "0xmanager-quant",
        isCurrentPlayer: false,
    },
    {
        address: "0xa90b...6ff2",
        displayName: "Range Runner",
        rank: 2,
        score: quote("1532200000"),
        deposited: quote("500000000"),
        predictManagerId: "0xmanager-range",
        isCurrentPlayer: false,
    },
];

const initialEvents: EventLog[] = [
    {
        id: "event-3",
        kind: "score-updated",
        title: "Leaderboard recalculated",
        detail: "Your mock score moved to 1,248.20 DUSDC.",
        actor: currentPlayerAddress,
        timestampMs: 1769988600000,
        isMock: true,
    },
    {
        id: "event-2",
        kind: "range-opened",
        title: "Range position opened",
        detail: "Range Runner opened SUI 3.00 - 4.00.",
        actor: "0xa90b...6ff2",
        timestampMs: 1769986800000,
        isMock: true,
    },
    {
        id: "event-1",
        kind: "player-joined",
        title: "Player joined",
        detail: "Entry amount recorded in the mock prize pool.",
        actor: "0x72de...4a10",
        timestampMs: 1769983200000,
        isMock: true,
    },
];

const vault: VaultState = {
    quoteAsset: deepArenaMockConfig.quoteSymbol,
    availableLiquidity: quote("892400000000"),
    markToMarketLiability: quote("241600000000"),
    maximumPayout: quote("487900000000"),
    utilizationPercent: "27.08",
};

const plp: PlpState = {
    coinType: deepArenaMockConfig.plpCoinType,
    totalSupply: "764300000000",
    priceInQuote: "1.0472",
    dayChangePercent: "0.82",
};

const clone = <T>(value: T): T => structuredClone(value);

function calculatePreview(
    kind: "binary" | "range",
    marketId: string,
    marketLabel: string,
    markPrice: string,
    quantity: string,
): ActionPreview {
    const normalizedQuantity = normalizeQuantity(quantity);
    const quantityNumber = Number(normalizedQuantity);
    const estimatedCostAtomic = Math.round(
        quantityNumber * Number(markPrice) * 1_000_000,
    ).toString();
    const estimatedPayoutAtomic = Math.round(quantityNumber * 1_000_000).toString();
    const feeAtomic = Math.round(Number(estimatedCostAtomic) * 0.0025).toString();

    return normalizeActionPreview({
        kind,
        marketId,
        marketLabel,
        quantity: normalizedQuantity,
        estimatedCostAtomic,
        estimatedPayoutAtomic,
        feeAtomic,
        decimals: deepArenaMockConfig.quoteDecimals,
        symbol: deepArenaMockConfig.quoteSymbol,
    });
}

export class MockDeepArenaClient implements DeepArenaClient {
    private arena = clone(initialArena);
    private players = clone(initialPlayers);
    private events = initialEvents.map(normalizeEventLog);

    async getArena() {
        return clone(this.arena);
    }

    async listPlayers() {
        return clone(this.players);
    }

    async listBinaryMarkets() {
        return clone(binaryMarkets);
    }

    async listRangeMarkets() {
        return clone(rangeMarkets);
    }

    async previewBinary(input: BinaryActionInput) {
        const market = binaryMarkets.find(({ id }) => id === input.marketId);
        if (!market) {
            throw new Error("Binary market not found");
        }
        return calculatePreview(
            "binary",
            market.id,
            market.label,
            market.markPrice,
            input.quantity,
        );
    }

    async openBinaryMock(input: BinaryActionInput) {
        return this.openMock(await this.previewBinary(input), "binary-opened");
    }

    async previewRange(input: RangeActionInput) {
        const market = rangeMarkets.find(({ id }) => id === input.marketId);
        if (!market) {
            throw new Error("Range market not found");
        }
        return calculatePreview("range", market.id, market.label, market.markPrice, input.quantity);
    }

    async openRangeMock(input: RangeActionInput) {
        return this.openMock(await this.previewRange(input), "range-opened");
    }

    async getVaultState() {
        return clone(vault);
    }

    async getPlpState() {
        return clone(plp);
    }

    async listEvents() {
        return clone(this.events);
    }

    private openMock(preview: ActionPreview, eventKind: EventKind): MockActionResult {
        const currentPlayer = this.players.find(({ isCurrentPlayer }) => isCurrentPlayer);
        if (!currentPlayer) {
            throw new Error("Current mock player not found");
        }

        const scoreDelta = Math.max(
            10_000_000,
            Math.round(Number(preview.estimatedCost.atomic) * 0.04),
        );
        currentPlayer.score.atomic = (Number(currentPlayer.score.atomic) + scoreDelta).toString();

        const event = normalizeEventLog({
            id: `event-mock-${Date.now()}`,
            kind: eventKind,
            title: `${preview.kind === "binary" ? "Binary" : "Range"} mock opened`,
            detail: `${preview.quantity} units of ${preview.marketLabel}; no transaction was sent.`,
            actor: currentPlayer.address,
            timestampMs: Date.now(),
            isMock: true,
        });
        this.events = [event, ...this.events];

        return {
            preview: clone(preview),
            arena: clone(this.arena),
            player: clone(currentPlayer),
            event: clone(event),
        };
    }
}

export function createMockDeepArenaClient(): DeepArenaClient {
    return new MockDeepArenaClient();
}
