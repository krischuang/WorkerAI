import { apiRateLimit, rateLimitResponse } from "@/lib/api-rate-limit";
import { getState, isLocalHost } from "@/lib/interview-live-demo";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/interview/live-comparison/stream
 *
 * Server-Sent Events stream of the live run's event log. Same shape as
 * app/api/tasks/[id]/logs/stream/route.ts: cursor-based tailing (here, the
 * in-memory event array's `seq` index rather than a DB row id), poll every
 * 500ms, close once the run reaches a terminal status and every event has
 * been sent.
 *
 * Query params:
 *   cursor: last `seq` the client already has (optional, default -1).
 */
export async function GET(request: NextRequest) {
  if (!isLocalHost(request.headers.get("host"))) {
    return new Response("This demo only runs against a localhost request.", { status: 403 });
  }

  const rl = apiRateLimit("interview:live-comparison:stream", 30, 60_000);
  if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

  const cursorParam = request.nextUrl.searchParams.get("cursor");
  const startCursor = cursorParam ? parseInt(cursorParam, 10) : -1;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let lastSeq = Number.isFinite(startCursor) ? startCursor : -1;
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const tick = () => {
        if (closed) return;

        const state = getState();
        const newEvents = state.events.filter((e) => e.seq > lastSeq);
        for (const ev of newEvents) {
          send("agent-event", ev);
          lastSeq = ev.seq;
        }

        if (state.status !== "running") {
          send("run-complete", { status: state.status, agentA: state.agentA, agentB: state.agentB, backendVerdict: state.backendVerdict, errorMessage: state.errorMessage });
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        }

        if (!closed) setTimeout(tick, 500);
      };

      tick();
    },

    cancel() {
      // Client disconnected. The demo run itself is not tied to this
      // connection, it keeps running server-side; a fresh GET with the
      // same cursor picks up where this left off.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
