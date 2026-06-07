export const BALANCE_REFRESH_EVENT = "deep-arena:balances-refresh";

export function requestBalanceRefresh(reason: string): void {
    if (typeof window === "undefined") {
        return;
    }
    window.dispatchEvent(new CustomEvent(BALANCE_REFRESH_EVENT, { detail: { reason } }));
}
