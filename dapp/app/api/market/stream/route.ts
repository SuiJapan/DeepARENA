import { createDeepbookPredictMarketStream } from "@/lib/market/deepbook-predict-server";
import type { MarketStreamEvent } from "@/lib/market/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function encodeSse(event: MarketStreamEvent): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export function GET(request: Request): Response {
    const url = new URL(request.url);
    const oracleId = url.searchParams.get("oracleId");
    let cleanupSession = () => {};
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            let closed = false;
            const session = createDeepbookPredictMarketStream(
                (event) => safeEnqueue(event),
                oracleId && oracleId.length > 0 ? oracleId : undefined,
            );

            function safeEnqueue(event: MarketStreamEvent): boolean {
                if (closed || request.signal.aborted) {
                    return false;
                }

                try {
                    controller.enqueue(encodeSse(event));
                    return true;
                } catch (caught) {
                    if (caught instanceof TypeError && isClosedControllerError(caught)) {
                        cleanup();
                        return false;
                    }
                    throw caught;
                }
            }

            function cleanup() {
                if (closed) {
                    return;
                }
                closed = true;
                session.close();
            }
            cleanupSession = cleanup;

            request.signal.addEventListener(
                "abort",
                () => {
                    cleanup();
                    try {
                        controller.close();
                    } catch {
                        // The browser can close the stream first; cleanup above is the important part.
                    }
                },
                { once: true },
            );
        },
        cancel() {
            cleanupSession();
        },
    });

    return new Response(stream, {
        headers: {
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream; charset=utf-8",
            "X-Accel-Buffering": "no",
        },
    });
}

function isClosedControllerError(caught: TypeError): boolean {
    return (
        caught.message.includes("Controller is already closed") ||
        caught.message.includes("Invalid state")
    );
}
