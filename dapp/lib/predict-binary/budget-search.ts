// 予算(budget)に対する最適数量(quantity)探索の純粋ロジック。
//
// 予測市場の mintCost(quantity) は数量に対して単調増加かつ凸（買うほど単価が上がる）。
// 1トークンの価格 < 1 なので、コストが budget に一致する数量は budget より大きい。
//
// 探索は RPC 往復を 2 ラウンドに保つため、
//   1) buildPreviewCandidateQuantities: 上限 4×budget までの幾何ラダーで budget コストを上下から挟む
//   2) buildVerificationQuantities: 挟んだ 2 点から割線(secant)で交点を高精度に推定
// とし、最後に selectBestBudgetedPreview が「コスト ≤ budget の最大数量」を選ぶ。
// 入力は「上限」ではなく「目標」として扱われ、結果のコストは budget に密着する。

export interface BudgetedQuantityPreview {
    quantity: bigint;
    mintCost: bigint;
}

export function uniquePositiveQuantities(values: bigint[]): bigint[] {
    const seen = new Set<string>();
    const quantities: bigint[] = [];
    for (const value of values) {
        if (value <= 0n) {
            continue;
        }
        const key = value.toString();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        quantities.push(value);
    }
    return quantities;
}

// ラウンド1: budget コストの交点(> budget 数量)を上下から挟むための幾何ラダー。
// 上限を 4×budget に抑えることで、過大な数量プローブによるプール枯渇アボート
// （バッチ全体失敗→低速フォールバック）のリスクを避ける。価格 >= 0.25（オッズ <= 4x）
// なら交点を挟める。それより低価格（高オッズ）はラウンド2で上方外挿する。
export function buildPreviewCandidateQuantities(budget: bigint): bigint[] {
    return uniquePositiveQuantities([
        1n,
        budget / 2n,
        budget,
        (budget * 3n) / 2n,
        budget * 2n,
        budget * 3n,
        budget * 4n,
    ]);
}

export function buildVerificationQuantities({
    budget,
    candidates,
}: {
    budget: bigint;
    candidates: BudgetedQuantityPreview[];
}): bigint[] {
    const priced = candidates.filter((candidate) => candidate.mintCost > 0n);
    if (priced.length === 0) {
        return [];
    }

    // コスト <= budget の最大数量(lo) と、コスト > budget の最小数量(hi) で交点を挟む。
    let lo: BudgetedQuantityPreview | null = null;
    let hi: BudgetedQuantityPreview | null = null;
    for (const candidate of priced) {
        if (candidate.mintCost <= budget) {
            if (!lo || candidate.quantity > lo.quantity) {
                lo = candidate;
            }
        } else {
            if (!hi || candidate.quantity < hi.quantity) {
                hi = candidate;
            }
        }
    }

    // 最小数量でも予算超過 → 予算が小さすぎる（呼び出し側で mintable なしとして失敗扱い）。
    if (!lo) {
        return [];
    }

    // ラダー全域が予算内（非常に低価格＝高オッズ）→ 上方へ線形外挿して追加プローブ。
    if (!hi) {
        const estimated = (budget * lo.quantity) / lo.mintCost;
        return uniquePositiveQuantities([
            estimated,
            (estimated + lo.quantity) / 2n,
            estimated * 2n,
        ]).filter((quantity) => quantity > lo.quantity);
    }

    // 凸性より割線交点は真の最大数量の下界になり、そのコストは budget 以下に収まる。
    const span = hi.quantity - lo.quantity;
    const costSpan = hi.mintCost - lo.mintCost;
    const secant =
        costSpan > 0n
            ? lo.quantity + ((budget - lo.mintCost) * span) / costSpan
            : (lo.quantity + hi.quantity) / 2n;
    const midSecHi = (secant + hi.quantity) / 2n;
    return uniquePositiveQuantities([
        secant - 1n,
        secant,
        secant + 1n,
        midSecHi,
        (secant + midSecHi) / 2n,
    ]).filter((quantity) => quantity > lo.quantity && quantity < hi.quantity);
}

export function selectBestBudgetedPreview<T extends BudgetedQuantityPreview>(
    budget: bigint,
    candidates: T[],
): T | null {
    return candidates.reduce<T | null>((best, candidate) => {
        if (candidate.mintCost <= 0n || candidate.mintCost > budget) {
            return best;
        }
        if (!best || candidate.quantity > best.quantity) {
            return candidate;
        }
        return best;
    }, null);
}
