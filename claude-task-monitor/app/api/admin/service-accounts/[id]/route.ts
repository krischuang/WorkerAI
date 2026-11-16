import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/require-admin";
import { revokeServiceAccount } from "@/lib/service-account";
import { logAdminAction } from "@/lib/admin-audit-log";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE /api/admin/service-accounts/[id]: revoke a key. Idempotent. */
export async function DELETE(request: NextRequest, ctx: Ctx) {
  const authResult = await requireAdmin(request);
  if (authResult) return authResult;

  const { id } = await ctx.params;
  await revokeServiceAccount(id);

  await logAdminAction(request, {
    action: "service_account.revoked",
    targetType: "ApiClient",
    targetId: id,
  });

  return NextResponse.json({ revoked: true });
}
