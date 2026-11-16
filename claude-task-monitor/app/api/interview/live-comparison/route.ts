import { NextResponse, type NextRequest } from "next/server";
import { apiRateLimit, rateLimitResponse } from "@/lib/api-rate-limit";
import { emitAudit } from "@/lib/audit";
import { getState, isLocalHost, resetRun, startLiveComparison } from "@/lib/interview-live-demo";

export const dynamic = "force-dynamic";

/**
 * Interview-only live demo: two real local `claude` CLI processes plus
 * WorkerAI's own real independent verification. See
 * lib/interview-live-demo.ts and docs/interview/LIVE-DEMO-README.md.
 *
 * GET: current run snapshot (status + full event log, for initial page
 * load or a browser refresh mid-run).
 * POST: start a new run. 409 if one is already in progress.
 * DELETE: reset back to idle, cleaning up the disposable workspace.
 *
 * Cookie auth is already required for every non-public path by default
 * (middleware.ts), this route adds nothing there. The extra isLocalHost
 * check below is specific to this feature: it spawns real local processes,
 * so it additionally refuses any request whose Host header isn't
 * localhost/127.0.0.1, even though the app itself may be bound to a wider
 * interface. Host is client-supplied, not a hard network boundary, see
 * the README's Known Limitations for what a real one would need.
 */
export async function GET() {
  return NextResponse.json(getState());
}

export async function POST(request: NextRequest) {
  if (!isLocalHost(request.headers.get("host"))) {
    return NextResponse.json({ error: "This demo only runs against a localhost request." }, { status: 403 });
  }

  const rl = apiRateLimit("interview:live-comparison:start", 5, 60_000);
  if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

  const result = startLiveComparison();
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }

  emitAudit({
    entityType: "interview-demo",
    entityId: "live-comparison",
    eventType: "interview_demo.started",
    actorType: "user",
    payload: {},
  }).catch(() => {});

  return NextResponse.json(getState(), { status: 202 });
}

export async function DELETE(request: NextRequest) {
  if (!isLocalHost(request.headers.get("host"))) {
    return NextResponse.json({ error: "This demo only runs against a localhost request." }, { status: 403 });
  }

  const result = resetRun();
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }
  return NextResponse.json(getState());
}
