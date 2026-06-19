import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/require-admin";
import {
  activateKillSwitch,
  deactivateKillSwitch,
  getKillSwitchState,
  getKillSwitchHistory,
  type KillSwitchReason,
} from "@/lib/kill-switch";
import { logAdminAction, type AdminAuditInput } from "@/lib/admin-audit-log";

/** GET /api/admin/kill-switch — current state + history */
export async function GET(request: NextRequest) {
  const authResult = await requireAdmin(request);
  if (authResult) return authResult;

  const [state, history] = await Promise.all([
    getKillSwitchState(),
    getKillSwitchHistory(20),
  ]);

  return NextResponse.json({ state, history });
}

/** POST /api/admin/kill-switch — activate or deactivate */
export async function POST(request: NextRequest) {
  const authResult = await requireAdmin(request);
  if (authResult) return authResult;

  const body = (await request.json()) as {
    action: "activate" | "deactivate";
    reason?: KillSwitchReason;
    detail?: string;
    activatedBy?: string;
  };

  if (!body.action || !["activate", "deactivate"].includes(body.action)) {
    return NextResponse.json({ error: "action must be 'activate' or 'deactivate'" }, { status: 400 });
  }

  const adminUser = body.activatedBy ?? "admin";

  if (body.action === "activate") {
    if (!body.reason) {
      return NextResponse.json({ error: "reason is required for activation" }, { status: 400 });
    }

    const state = await activateKillSwitch({
      reason: body.reason,
      detail: body.detail,
      activatedBy: adminUser,
    });

    const activateInput: AdminAuditInput = {
      action: "kill_switch.activated",
      targetType: "SystemConfig",
      targetId: "kill_switch",
    };
    await logAdminAction(request, activateInput);

    return NextResponse.json({ state });
  } else {
    const state = await deactivateKillSwitch({
      deactivatedBy: adminUser,
      detail: body.detail,
    });

    const deactivateInput: AdminAuditInput = {
      action: "kill_switch.deactivated",
      targetType: "SystemConfig",
      targetId: "kill_switch",
    };
    await logAdminAction(request, deactivateInput);

    return NextResponse.json({ state });
  }
}
