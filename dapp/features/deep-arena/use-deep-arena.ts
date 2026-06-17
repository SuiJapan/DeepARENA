"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DeepArenaClient } from "@/lib/deep-arena/client";
import { createDeepArenaClient } from "@/lib/deep-arena/factory";
import type {
    ActionPreview,
    BinaryActionInput,
    DeepArenaSnapshot,
    RangeActionInput,
} from "@/lib/deep-arena/types";

async function loadSnapshot(client: DeepArenaClient): Promise<DeepArenaSnapshot> {
    const [arena, players, binaryMarkets, rangeMarkets, vault, plp, events] = await Promise.all([
        client.getArena(),
        client.listPlayers(),
        client.listBinaryMarkets(),
        client.listRangeMarkets(),
        client.getVaultState(),
        client.getPlpState(),
        client.listEvents(),
    ]);
    return { arena, players, binaryMarkets, rangeMarkets, vault, plp, events };
}

export function useDeepArena(clientOverride?: DeepArenaClient) {
    const mockClient = useMemo(createDeepArenaClient, []);
    const client = clientOverride ?? mockClient;
    const [snapshot, setSnapshot] = useState<DeepArenaSnapshot | null>(null);
    const [preview, setPreview] = useState<ActionPreview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isActing, setIsActing] = useState(false);

    const refresh = useCallback(async () => {
        setError(null);
        try {
            setSnapshot(await loadSnapshot(client));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Failed to load Deep Arena");
        } finally {
            setIsLoading(false);
        }
    }, [client]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const runAction = useCallback(
        async (action: () => Promise<unknown>) => {
            setIsActing(true);
            setError(null);
            try {
                await action();
                await refresh();
            } catch (caught) {
                setError(caught instanceof Error ? caught.message : "Mock action failed");
            } finally {
                setIsActing(false);
            }
        },
        [refresh],
    );

    const runPreview = useCallback(async (action: () => Promise<ActionPreview>) => {
        setError(null);
        try {
            setPreview(await action());
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Preview failed");
        }
    }, []);

    const previewBinary = useCallback(
        (input: BinaryActionInput) => runPreview(() => client.previewBinary(input)),
        [client, runPreview],
    );

    const previewRange = useCallback(
        (input: RangeActionInput) => runPreview(() => client.previewRange(input)),
        [client, runPreview],
    );

    const openBinaryMock = useCallback(
        (input: BinaryActionInput) => runAction(() => client.openBinaryMock(input)),
        [client, runAction],
    );

    const openRangeMock = useCallback(
        (input: RangeActionInput) => runAction(() => client.openRangeMock(input)),
        [client, runAction],
    );

    return {
        snapshot,
        preview,
        error,
        isLoading,
        isActing,
        previewBinary,
        previewRange,
        openBinaryMock,
        openRangeMock,
    };
}
