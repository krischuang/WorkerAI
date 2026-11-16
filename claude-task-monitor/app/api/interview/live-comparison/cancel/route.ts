import { NextResponse, type NextRequest } from "next/server";
import { emitAudit } from "@/lib/audit";
import { cancelRun, getState, isLocalHost } from "@/lib/interview-live-demo";

export const dynamic = "force-dynamic";

/** POST /api/interview/live-comparison/cancel: kills both real child
 *  processes immediately (SIGTERM, then SIGKILL after 3s) and marks the
 *  run cancelled. 409 if no run is in progress. */
export async function POST(request: NextRequest) {
  if (!isLocalHost(request.headers.get("host"))) {
    return NextResponse.json({ error: "This demo only runs against a localhost request." }, { status: 403 });
  }

  const result = cancelRun();
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }

  emitAudit({
    entityType: "interview-demo",
    entityId: "live-comparison",
    eventType: "interview_demo.cancelled",
    actorType: "user",
    payload: {},
  }).catch(() => {});

  return NextResponse.json(getState());
}
