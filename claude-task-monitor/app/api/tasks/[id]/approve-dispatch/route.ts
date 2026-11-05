import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { requireAdmin } from "@/lib/require-admin";
import { evaluateDispatchPolicy, evaluatePolicy, grantPolicyApproval } from "@/lib/policy-engine";

type Ctx = { params: Promise<{ id: string }> };

const MAX_TTL_MINUTES = 240;

/**
 * Grants a one-time, time-limited policy approval for a task whose policy
 * evaluation returned "require_approval" — either at dispatch time
 * (lib/task-dispatch.ts, "code_execution" category, evaluated by riskLevel
 * before any work starts) or at the post-execution file-level gate
 * (lib/validation-gate.ts, "file_change" category, evaluated against the
 * files the agent actually touched).
 *
 * An approval is scoped to exactly the category (and, for file_change, the
 * exact file set) it was granted against — it can never be reused to satisfy
 * a different kind of pending decision for the same task — and expires after
 * ttlMinutes (default 30, hard-capped at 4 hours). It is consumed (deleted)
 * the first time the matching gate uses it.
 *
 * This route only grants the approval — it does not re-trigger dispatch or
 * completion itself. For a dispatch-time approval, re-run the task from the
 * UI/queue afterward. For a file-level approval, re-run validation.
 */
export async function POST(request: NextRequest, ctx: Ctx) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  try {
    const { id } = await ctx.params;

    const task = await prisma.task.findUnique({
      where: { id },
      select: { id: true, riskLevel: true },
    });
    if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const category: string = body.category ?? "code_execution";
    const ttlMinutes = typeof body.ttlMinutes === "number"
      ? Math.min(Math.max(body.ttlMinutes, 1), MAX_TTL_MINUTES)
      : undefined;

    if (category === "code_execution") {
      const policyResult = await evaluateDispatchPolicy({ taskId: id, riskLevel: task.riskLevel });
      if (!policyResult.requiresApproval) {
        return NextResponse.json(
          { error: "This task's current dispatch-time policy evaluation does not require approval." },
          { status: 400 },
        );
      }

      const record = await grantPolicyApproval({
        taskId: id,
        approvedBy: "admin",
        category: "code_execution",
        ttlMinutes,
        detail: `Approved via POST /api/tasks/${id}/approve-dispatch`,
      });
      return NextResponse.json({ approved: true, taskId: id, category, expiresAt: record.expiresAt });
    }

    if (category === "file_change") {
      const filePaths: unknown = body.filePaths;
      if (!Array.isArray(filePaths) || filePaths.length === 0 || !filePaths.every((p) => typeof p === "string")) {
        return NextResponse.json(
          { error: "file_change approval requires a non-empty filePaths array naming exactly what is being approved." },
          { status: 400 },
        );
      }

      const filePolicy = await evaluatePolicy({ taskId: id, category: "file_change", filePaths });
      if (filePolicy.decision === "deny") {
        return NextResponse.json(
          { error: "This file set is denied outright by policy and cannot be approved." },
          { status: 403 },
        );
      }
      if (filePolicy.decision !== "require_approval") {
        return NextResponse.json(
          { error: "This file set does not currently require approval." },
          { status: 400 },
        );
      }

      const record = await grantPolicyApproval({
        taskId: id,
        approvedBy: "admin",
        category: "file_change",
        ttlMinutes,
        detail: `Approved via POST /api/tasks/${id}/approve-dispatch for files: ${filePaths.join(", ")}`,
      });
      return NextResponse.json({ approved: true, taskId: id, category, filePaths, expiresAt: record.expiresAt });
    }

    return NextResponse.json({ error: `Unknown category "${category}"` }, { status: 400 });
  } catch (err) {
    return serverError("tasks/[id]/approve-dispatch POST", err);
  }
}
