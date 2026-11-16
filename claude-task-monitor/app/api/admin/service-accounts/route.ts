import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/require-admin";
import { createServiceAccount, listServiceAccounts } from "@/lib/service-account";
import { logAdminAction } from "@/lib/admin-audit-log";
import { prisma } from "@/lib/prisma";

/** GET /api/admin/service-accounts: list all (hash/raw key never included). */
export async function GET(request: NextRequest) {
  const authResult = await requireAdmin(request);
  if (authResult) return authResult;

  const accounts = await listServiceAccounts();
  return NextResponse.json({ accounts });
}

/**
 * POST /api/admin/service-accounts: mint a new scoped key.
 *
 * Body: { name: string, projectIds: string[] }
 * projectIds must be non-empty and must reference real projects. An admin
 * cannot accidentally create a key scoped to nothing, nor to IDs that don't
 * exist (which would otherwise silently resolve to "no access" and look
 * like a bug rather than the explicit empty-scope design intent).
 *
 * The raw key is returned exactly once in this response body.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAdmin(request);
  if (authResult) return authResult;

  const body = (await request.json().catch(() => null)) as { name?: string; projectIds?: string[] } | null;
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (!Array.isArray(body.projectIds) || body.projectIds.length === 0) {
    return NextResponse.json({ error: "projectIds must be a non-empty array" }, { status: 400 });
  }

  const existing = await prisma.project.findMany({
    where: { id: { in: body.projectIds } },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((p) => p.id));
  const unknown = body.projectIds.filter((id) => !existingIds.has(id));
  if (unknown.length > 0) {
    return NextResponse.json({ error: `Unknown project ID(s): ${unknown.join(", ")}` }, { status: 400 });
  }

  const { rawKey, summary } = await createServiceAccount({
    name: body.name.trim(),
    projectIds: body.projectIds,
  });

  await logAdminAction(request, {
    action: "service_account.created",
    targetType: "ApiClient",
    targetId: summary.id,
    payload: { name: summary.name, projectIds: summary.projectIds },
  });

  return NextResponse.json({ rawKey, account: summary }, { status: 201 });
}
