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

  // Declared outside both ReadableStream callbacks so `cancel()` (a sibling
  // of `start()`, not nested inside it) can actually see and set it. It
  // previously declared its own `closed` inside `start()`, which `cancel()`
  // had no access to at all, so closing the connection client-side never
  // stopped this tick() loop server-side.
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      let lastSeq = Number.isFinite(startCursor) ? startCursor : -1;

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
          // Send the FULL current state, not a hand-picked field list. The
          // bug this fixes: RunState grew implementationDiff and
          // verificationLabel after this payload was first written, and
          // this list was never updated, so the client's merged state kept
          // verificationLabel stuck at null forever (the Final Decision
          // panel showing "not run") even though the execution log, driven
          // by individual event text, already showed the real verdict.
          // Sending the whole object makes that whole class of drift
          // structurally impossible: there is nothing left to forget.
          send("run-complete", state);
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
      // Client disconnected (tab closed, EventSource.close() called, page
      // navigated away). The demo run itself is not tied to this
      // connection and keeps running server-side, a fresh GET with the
      // same cursor picks up where this left off, but THIS tick() loop
      // must stop polling now. Without this, every closed connection left
      // an orphaned setTimeout(tick, 500) loop running indefinitely in the
      // background (it would eventually self-terminate once `send` throws
      // on the closed controller, but only after however many ticks that
      // takes, wasted work and a real, if minor, resource leak per
      // abandoned connection).
      closed = true;
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
