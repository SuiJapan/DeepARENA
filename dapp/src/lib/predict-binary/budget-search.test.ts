import assert from "node:assert/strict";
import test from "node:test";
import {
    type BudgetedQuantityPreview,
    buildPreviewCandidateQuantities,
    buildVerificationQuantities,
    selectBestBudgetedPreview,
} from "./budget-search.ts";

const UNIT = 1_000_000; // quantityUnit (1 token)

// 合成の凸コスト関数: 限界価格 = p0 + k*(q/UNIT) → コスト = p0*q + k*q^2/(2*UNIT)。
// p0 ∈ (0,1) は初期トークン価格、k は流動性の薄さ（曲率）。
function makeConvexCost(p0: number, k: number): (quantity: bigint) => bigint {
    return (quantity: bigint): bigint => {
        const q = Number(quantity);
        const cost = p0 * q + (k * q * q) / (2 * UNIT);
        return BigInt(Math.round(cost));
    };
}

// 2ラウンド探索をシミュレートし、選ばれた最良候補を返す。
function runTwoRoundSearch(
    budget: bigint,
    cost: (quantity: bigint) => bigint,
): BudgetedQuantityPreview | null {
    const round1 = buildPreviewCandidateQuantities(budget).map((quantity) => ({
        quantity,
        mintCost: cost(quantity),
    }));
    const round2Quantities = buildVerificationQuantities({ budget, candidates: round1 });
    const round2 = round2Quantities.map((quantity) => ({ quantity, mintCost: cost(quantity) }));
    return selectBestBudgetedPreview(budget, [...round1, ...round2]);
}

test("buildPreviewCandidateQuantities brackets the budget cost from both sides for mid prices", () => {
    const budget = 1_000_000n;
    const cost = makeConvexCost(0.5, 0.5);
    const candidates = buildPreviewCandidateQuantities(budget).map((quantity) => ({
        quantity,
        mintCost: cost(quantity),
    }));
    assert.ok(
        candidates.some((c) => c.mintCost <= budget),
        "expected at least one affordable candidate",
    );
    assert.ok(
        candidates.some((c) => c.mintCost > budget),
        "expected at least one over-budget candidate to bracket from above",
    );
});

test("two-round search lands within 5% of budget across a range of prices/curvatures", () => {
    const budget = 1_000_000n;
    const cases: Array<{ p0: number; k: number }> = [
        { p0: 0.5, k: 0.5 }, // 中価格・高曲率（報告された下振れケースに近い）
        { p0: 0.5, k: 0.05 }, // 中価格・低曲率（深い流動性）
        { p0: 0.7, k: 0.3 },
        { p0: 0.3, k: 0.3 },
        { p0: 0.9, k: 0.1 }, // 高価格（低オッズ）
        { p0: 0.4, k: 1.0 }, // 強い曲率
    ];
    for (const { p0, k } of cases) {
        const cost = makeConvexCost(p0, k);
        const best = runTwoRoundSearch(budget, cost);
        assert.ok(best, `expected a mintable result for p0=${p0} k=${k}`);
        assert.ok(
            best.mintCost <= budget,
            `cost ${best.mintCost} must not exceed budget ${budget} (p0=${p0} k=${k})`,
        );
        const residual = budget - best.mintCost;
        const tolerance = budget / 20n; // 5%
        assert.ok(
            residual <= tolerance,
            `residual ${residual} exceeded 5% of budget for p0=${p0} k=${k} (cost=${best.mintCost})`,
        );
    }
});

test("two-round search beats the naive max-affordable-from-round1 baseline", () => {
    const budget = 1_000_000n;
    const cost = makeConvexCost(0.5, 0.5);
    const round1 = buildPreviewCandidateQuantities(budget).map((quantity) => ({
        quantity,
        mintCost: cost(quantity),
    }));
    const round1Best = selectBestBudgetedPreview(budget, round1);
    const twoRoundBest = runTwoRoundSearch(budget, cost);
    assert.ok(round1Best && twoRoundBest);
    assert.ok(
        twoRoundBest.mintCost >= round1Best.mintCost,
        "two-round result should be at least as close to budget as round 1 alone",
    );
});

test("returns no verification quantities when every probe exceeds the budget", () => {
    const budget = 100n;
    // すべての候補がコスト > budget（最小数量でも予算超過）。
    const candidates = buildPreviewCandidateQuantities(budget).map((quantity) => ({
        quantity,
        mintCost: budget + quantity, // 必ず予算超過
    }));
    assert.deepEqual(buildVerificationQuantities({ budget, candidates }), []);
    assert.equal(selectBestBudgetedPreview(budget, candidates), null);
});

test("returns no verification quantities when there are no priced candidates", () => {
    assert.deepEqual(buildVerificationQuantities({ budget: 1_000_000n, candidates: [] }), []);
});

test("all verification quantities stay strictly inside the bracket", () => {
    const budget = 1_000_000n;
    const cost = makeConvexCost(0.5, 0.5);
    const round1 = buildPreviewCandidateQuantities(budget).map((quantity) => ({
        quantity,
        mintCost: cost(quantity),
    }));
    const priced = round1.filter((c) => c.mintCost > 0n);
    const lo = priced
        .filter((c) => c.mintCost <= budget)
        .reduce((a, b) => (b.quantity > a.quantity ? b : a));
    const hi = priced
        .filter((c) => c.mintCost > budget)
        .reduce((a, b) => (b.quantity < a.quantity ? b : a));
    const verification = buildVerificationQuantities({ budget, candidates: round1 });
    for (const q of verification) {
        assert.ok(
            q > lo.quantity && q < hi.quantity,
            `verification quantity ${q} outside bracket (${lo.quantity}, ${hi.quantity})`,
        );
    }
});
