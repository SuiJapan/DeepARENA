import assert from "node:assert/strict";
import test from "node:test";
import {
    BETTING_CLOSE_OFFSET_MS,
    buildRoundStrikes,
    buildSettlementRoundLock,
    calculateBettingClose,
    calculateRoundOpen,
    formatRoundCountdownClock,
    getRoundStatus,
    isGridStrike,
    type OracleCandidate,
    selectCurrentBtcOracle,
    selectNearestGridStrike,
} from "./round.ts";

const expiryMs = 1_800_000_000_000;
const grid = { minStrike: 60_000_000_000_000n, tickSize: 100_000_000_000n };

function oracle(overrides: Partial<OracleCandidate>): OracleCandidate {
    return {
        oracleId: "btc",
        underlyingAsset: "BTC",
        lifecycle: "active",
        expiryMs,
        activatedAtMs: null,
        ...overrides,
    };
}

test("sorts future active BTC oracles by expiry and selects the nearest current oracle", () => {
    const selected = selectCurrentBtcOracle(
        [
            oracle({ oracleId: "btc-3", expiryMs: 4_000 }),
            oracle({ oracleId: "btc-1", expiryMs: 2_000 }),
            oracle({ oracleId: "btc-2", expiryMs: 3_000 }),
        ],
        1_000,
    );
    assert.equal(selected.currentOracle?.oracleId, "btc-1");
    assert.equal(selected.nextOracle?.oracleId, "btc-2");
});

test("does not choose settled, inactive, expired, or non-BTC oracles as current", () => {
    const selected = selectCurrentBtcOracle(
        [
            oracle({ oracleId: "settled", lifecycle: "settled", expiryMs: 2_000 }),
            oracle({ oracleId: "inactive", lifecycle: "created", expiryMs: 3_000 }),
            oracle({ oracleId: "expired", expiryMs: 500 }),
            oracle({ oracleId: "eth", underlyingAsset: "ETH", expiryMs: 1_500 }),
            oracle({ oracleId: "active-btc", expiryMs: 4_000 }),
        ],
        1_000,
    );
    assert.equal(selected.currentOracle?.oracleId, "active-btc");
});

test("does not fall back to settled BTC when no future active BTC oracle exists", () => {
    const selected = selectCurrentBtcOracle(
        [oracle({ oracleId: "settled", lifecycle: "settled", expiryMs: 500 })],
        1_000,
    );
    assert.equal(selected.currentOracle, null);
});

test("switches to the next active oracle after current expiry", () => {
    const oracles = [
        oracle({ oracleId: "first", expiryMs: 2_000 }),
        oracle({ oracleId: "second", expiryMs: 3_000 }),
    ];
    assert.equal(selectCurrentBtcOracle(oracles, 1_000).currentOracle?.oracleId, "first");
    assert.equal(selectCurrentBtcOracle(oracles, 2_001).currentOracle?.oracleId, "second");
});

test("uses previous BTC expiry as round open and falls back to activation or first price", () => {
    assert.equal(
        calculateRoundOpen({
            previousExpiryMs: 1_000,
            activatedAtMs: 1_100,
        }),
        1_000,
    );
    assert.equal(
        calculateRoundOpen({
            previousExpiryMs: null,
            activatedAtMs: 1_100,
        }),
        1_100,
    );
    assert.equal(
        calculateRoundOpen({
            previousExpiryMs: null,
            activatedAtMs: null,
        }),
        null,
    );
});

test("sets betting close to expiry minus five minutes", () => {
    assert.equal(calculateBettingClose(expiryMs), expiryMs - BETTING_CLOSE_OFFSET_MS);
});

test("returns BETTING_OPEN before betting close and FINAL_LIVE in the final five minutes", () => {
    const bettingCloseMs = calculateBettingClose(expiryMs);
    assert.equal(
        getRoundStatus({
            nowMs: bettingCloseMs - 1,
            bettingCloseMs,
            expiryMs,
            hasOpeningSpot: true,
            oracleLifecycle: "active",
        }),
        "BETTING_OPEN",
    );
    assert.equal(
        getRoundStatus({
            nowMs: bettingCloseMs,
            bettingCloseMs,
            expiryMs,
            hasOpeningSpot: true,
            oracleLifecycle: "active",
        }),
        "FINAL_LIVE",
    );
});

test("selects the nearest valid grid strike from opening spot with lower tie-break", () => {
    assert.equal(selectNearestGridStrike(60_140_000_000_000n, grid), 60_100_000_000_000n);
    assert.equal(selectNearestGridStrike(60_160_000_000_000n, grid), 60_200_000_000_000n);
    assert.equal(selectNearestGridStrike(60_150_000_000_000n, grid), 60_100_000_000_000n);
});

test("rebuilds the same binary strike from the same oracle grid and opening spot", () => {
    const left = buildRoundStrikes(60_160_000_000_000n, grid);
    const right = buildRoundStrikes(60_160_000_000_000n, grid);
    assert.deepEqual(left, right);
    assert.equal(isGridStrike(left.binaryStrike, grid), true);
});

test("uses the previous oracle settlement price as the opening spot", () => {
    const lock = buildSettlementRoundLock({
        currentOracleId: "current",
        previousOracleId: "previous",
        previousExpiryMs: 1_000,
        openingSpotRaw: "60160000000000",
        grid,
    });

    assert.equal(lock.roundOpenMs, 1_000);
    assert.equal(lock.openingSpotRaw, "60160000000000");
});

test("keeps binary strike fixed while previous settlement price is unchanged", () => {
    const input = {
        currentOracleId: "current",
        previousOracleId: "previous",
        previousExpiryMs: 1_000,
        openingSpotRaw: "60160000000000",
        grid,
    };

    assert.deepEqual(buildSettlementRoundLock(input), buildSettlementRoundLock(input));
});

test("does not use current price when building the binary strike", () => {
    const lock = buildSettlementRoundLock({
        currentOracleId: "current",
        previousOracleId: "previous",
        previousExpiryMs: 1_000,
        openingSpotRaw: "60160000000000",
        grid,
    });

    const changedCurrentSpotRaw = "65000000000000";
    const currentSpotStrike = buildRoundStrikes(BigInt(changedCurrentSpotRaw), grid);
    assert.notEqual(lock.binaryStrikeRaw, currentSpotStrike.binaryStrike.toString());
    assert.equal(lock.binaryStrikeRaw, "60200000000000");
});

test("rebuilds the same reference strike across repeated API-style constructions", () => {
    const locks = Array.from({ length: 100 }, () =>
        buildSettlementRoundLock({
            currentOracleId: "current",
            previousOracleId: "previous",
            previousExpiryMs: 1_000,
            openingSpotRaw: "60160000000000",
            grid,
        }),
    );

    assert.equal(new Set(locks.map((lock) => lock.binaryStrikeRaw)).size, 1);
    assert.equal(new Set(locks.map((lock) => lock.roundId)).size, 1);
});

test("builds the same reference strike for a reload-equivalent fresh state", () => {
    const create = () =>
        buildSettlementRoundLock({
            currentOracleId: "current",
            previousOracleId: "previous",
            previousExpiryMs: 1_000,
            openingSpotRaw: "60160000000000",
            grid,
        });

    assert.deepEqual(create(), create());
});

test("builds a round without oracle price update history", () => {
    const lock = buildSettlementRoundLock({
        currentOracleId: "current",
        previousOracleId: "previous",
        previousExpiryMs: 1_000,
        openingSpotRaw: "60160000000000",
        grid,
    });

    assert.equal(lock.roundId, "current:previous:1000");
});

test("keeps the round locked before previous settlement price exists", () => {
    assert.equal(
        getRoundStatus({
            nowMs: 1_100,
            bettingCloseMs: 1_700,
            expiryMs: 2_000,
            hasOpeningSpot: false,
            oracleLifecycle: "active",
        }),
        "LOCKING_ROUND",
    );
});

test("moves to betting open after previous settlement price exists", () => {
    assert.equal(
        getRoundStatus({
            nowMs: 1_100,
            bettingCloseMs: 1_700,
            expiryMs: 2_000,
            hasOpeningSpot: true,
            oracleLifecycle: "active",
        }),
        "BETTING_OPEN",
    );
});

test("does not let a newly activated shorter oracle steal the current round", () => {
    const selected = selectCurrentBtcOracle(
        [
            oracle({ oracleId: "previous", lifecycle: "settled", expiryMs: 1_000 }),
            oracle({ oracleId: "current", expiryMs: 2_000, activatedAtMs: 900 }),
            oracle({ oracleId: "new-short", expiryMs: 1_500, activatedAtMs: 1_100 }),
            oracle({ oracleId: "next", expiryMs: 3_000, activatedAtMs: 900 }),
        ],
        1_200,
    );

    assert.equal(selected.currentOracle?.oracleId, "current");
});

test("formats round countdowns as HH:MM:SS", () => {
    assert.equal(
        formatRoundCountdownClock(2 * 86_400_000 + 3 * 3_600_000 + 12 * 60_000),
        "51:12:00",
    );
    assert.equal(formatRoundCountdownClock(11 * 3_600_000 + 52 * 60_000), "11:52:00");
    assert.equal(formatRoundCountdownClock(42 * 60_000 + 18_000), "00:42:18");
    assert.equal(formatRoundCountdownClock(48_000), "00:00:48");
    assert.equal(formatRoundCountdownClock(4 * 60_000 + 59_000), "00:04:59");
});
