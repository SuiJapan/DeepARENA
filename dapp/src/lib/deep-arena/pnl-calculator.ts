/**
 * ランキング PnL のオフチェーン再構築（純粋計算ロジック）。
 *
 * 方針A（docs/ranking-pnl-fix/approach-a-design.md）:
 *   - コスト＋手数料は DeepARENA の *Opened イベントから（BET は必ず DeepARENA 経由なので完全）。
 *   - 払戻は Predict 層の PositionRedeemed / RangeRedeemed イベントから（redeem 経路に依存せず全件捕捉）。
 *   - 払戻は manager_id でしか紐づかないため、arena が「所有」する建玉数量を上限にキー単位で按分帰属する
 *     （arena 外取引の払戻を誤加点しない）。
 *   - PnL = attributedPayout − cost − fee（0 床を取らない。負値も返す）。実現損益のみ。
 *
 * 本モジュールは I/O を持たない純関数群。イベント取得・パースは呼び出し側（contract-client）が行う。
 */

/** *Opened イベント 1 件分の寄与（コスト・手数料は 1 回、建玉キーは binary 1 / break 2 / range 1）。 */
export interface OpenedContribution {
    managerId: string;
    cost: bigint;
    fee: bigint;
    /** binary 建玉キー（break は 2 レッグ分入る）。keyStr は binaryKey() で生成。 */
    binary: Array<{ keyStr: string; quantity: bigint }>;
    /** range 建玉キー。keyStr は rangeKey() で生成。 */
    range: Array<{ keyStr: string; quantity: bigint }>;
}

/** redeem イベント 1 件分の払戻寄与。 */
export interface RedeemContribution {
    managerId: string;
    kind: "binary" | "range";
    keyStr: string;
    quantity: bigint;
    payout: bigint;
    /** 時刻昇順ソート用（不明なら 0）。 */
    timestampMs: number;
    /** 同時刻のタイブレーク用（不明なら ""）。 */
    tieBreak: string;
}

/** マネージャー単位の PnL 内訳。 */
export interface ManagerPnl {
    /** attributedPayout − cost − fee（負値あり）。 */
    pnl: bigint;
    cost: bigint;
    fee: bigint;
    payout: bigint;
}

/** ID を正規化（小文字化）。Opened(deep_arena) と Redeem(predict) のキー一致のため。 */
export function normalizeId(id: string): string {
    return id.toLowerCase();
}

/** binary ポジションキー文字列。manager は呼び出し側で名前空間化するため含めない。 */
export function binaryKey(oracleId: string, expiry: bigint, strike: bigint, isUp: boolean): string {
    return `${normalizeId(oracleId)}|${expiry.toString()}|${strike.toString()}|${isUp ? "1" : "0"}`;
}

/** range ポジションキー文字列。 */
export function rangeKey(
    oracleId: string,
    expiry: bigint,
    lowerStrike: bigint,
    higherStrike: bigint,
): string {
    return `${normalizeId(oracleId)}|${expiry.toString()}|${lowerStrike.toString()}|${higherStrike.toString()}`;
}

interface ManagerAccumulator {
    cost: bigint;
    fee: bigint;
    openedBinary: Map<string, bigint>;
    openedRange: Map<string, bigint>;
    payout: bigint;
}

function getOrCreate(acc: Map<string, ManagerAccumulator>, managerId: string): ManagerAccumulator {
    let m = acc.get(managerId);
    if (!m) {
        m = {
            cost: 0n,
            fee: 0n,
            openedBinary: new Map(),
            openedRange: new Map(),
            payout: 0n,
        };
        acc.set(managerId, m);
    }
    return m;
}

/**
 * PnL を再構築する。
 *
 * @param opened   全 *Opened 寄与（arena_id で既にフィルタ済みのもの）
 * @param redeemed 全 redeem 寄与（Predict 全ユーザー分。arena 外マネージャーは自動的に帰属 0）
 * @returns        managerId → ManagerPnl（opened を 1 件以上持つマネージャーのみ）
 */
export function computePnl(
    opened: OpenedContribution[],
    redeemed: RedeemContribution[],
): Map<string, ManagerPnl> {
    const acc = new Map<string, ManagerAccumulator>();

    // Step 2: opened からコスト・手数料・建玉数量を集計
    for (const o of opened) {
        const m = getOrCreate(acc, o.managerId);
        m.cost += o.cost;
        m.fee += o.fee;
        for (const b of o.binary) {
            m.openedBinary.set(b.keyStr, (m.openedBinary.get(b.keyStr) ?? 0n) + b.quantity);
        }
        for (const r of o.range) {
            m.openedRange.set(r.keyStr, (m.openedRange.get(r.keyStr) ?? 0n) + r.quantity);
        }
    }

    // Step 3: redeem を時刻昇順で処理し、キー単位の累積上限で payout を帰属
    const sorted = [...redeemed].sort((a, b) => {
        if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
        if (a.tieBreak < b.tieBreak) return -1;
        if (a.tieBreak > b.tieBreak) return 1;
        return 0;
    });

    // composite "managerId|kind|keyStr" → 残り帰属可能数量
    const remaining = new Map<string, bigint>();

    for (const r of sorted) {
        const m = acc.get(r.managerId);
        // arena で建玉していないマネージャー（arena 外取引のみ）は帰属対象外
        if (!m) continue;

        const openedQty =
            (r.kind === "binary" ? m.openedBinary : m.openedRange).get(r.keyStr) ?? 0n;
        if (openedQty <= 0n) continue;

        const compositeKey = `${r.managerId}|${r.kind}|${r.keyStr}`;
        const rem = remaining.has(compositeKey)
            ? (remaining.get(compositeKey) as bigint)
            : openedQty;
        if (rem <= 0n) {
            remaining.set(compositeKey, rem);
            continue;
        }

        const attributableQty = r.quantity < rem ? r.quantity : rem;
        // payout * attributableQty / quantity（乗算先行→整数除算。全量帰属時は丸め誤差ゼロ）
        const attributedPayout =
            r.quantity === attributableQty || r.quantity === 0n
                ? r.payout
                : (r.payout * attributableQty) / r.quantity;
        m.payout += attributedPayout;
        remaining.set(compositeKey, rem - attributableQty);
    }

    // Step 4: PnL 確定
    const result = new Map<string, ManagerPnl>();
    for (const [managerId, m] of acc) {
        result.set(managerId, {
            pnl: m.payout - m.cost - m.fee,
            cost: m.cost,
            fee: m.fee,
            payout: m.payout,
        });
    }
    return result;
}
