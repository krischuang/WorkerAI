import { NextResponse, type NextRequest } from "next/server";
import { requestCredential, revokeAllTaskCredentials, getBrokerMetrics } from "@/lib/secret-broker";
import { isSubsystemHalted } from "@/lib/kill-switch";

/**
 * POST /api/secret-broker/credential
 * Request a temporary credential for a task.
 * Called by agents that need access to a secret.
 */
export async function POST(request: NextRequest) {
  // Check kill switch
  if (await isSubsystemHalted("taskDispatch")) {
    return NextResponse.json(
      { error: "Platform kill switch active — secret access suspended" },
      { status: 503 },
    );
  }

  const body = (await request.json()) as {
    taskId?: string;
    secretKey?: string;
    requesterId?: string;
    requesterType?: "agent" | "server";
    ttlSeconds?: number;
  };

  if (!body.taskId || !body.secretKey || !body.requesterId || !body.requesterType) {
    return NextResponse.json(
      { error: "taskId, secretKey, requesterId, and requesterType are required" },
      { status: 400 },
    );
  }

  if (!["agent", "server"].includes(body.requesterType)) {
    return NextResponse.json({ error: "requesterType must be 'agent' or 'server'" }, { status: 400 });
  }

  const result = await requestCredential({
    taskId: body.taskId,
    secretKey: body.secretKey,
    requesterId: body.requesterId,
    requesterType: body.requesterType,
    ttlSeconds: body.ttlSeconds,
  });

  if (!result.ok) {
    const status =
      result.reason === "not_found" ? 404 :
      result.reason === "policy_denied" ? 403 :
      result.reason === "task_not_running" ? 409 :
      400;
    return NextResponse.json({ error: result.reason, detail: result.detail }, { status });
  }

  return NextResponse.json({
    credentialId: result.credential.credentialId,
    value: result.credential.value,
    expiresAt: result.credential.expiresAt.toISOString(),
    accessToken: result.credential.accessToken,
  });
}

/**
 * DELETE /api/secret-broker/credential?taskId=xxx
 * Revoke all credentials for a task.
 */
export async function DELETE(request: NextRequest) {
  const taskId = request.nextUrl.searchParams.get("taskId");
  if (!taskId) {
    return NextResponse.json({ error: "taskId query parameter required" }, { status: 400 });
  }

  const revoked = await revokeAllTaskCredentials(taskId, "api_revocation");
  return NextResponse.json({ revoked });
}

/**
 * GET /api/secret-broker/credential — broker metrics (admin only)
 */
export async function GET() {
  return NextResponse.json(getBrokerMetrics());
}
