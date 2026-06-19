import { NextResponse, type NextRequest } from "next/server";
import { getKillSwitchState } from "@/lib/kill-switch";
import { getFirewallStats } from "@/lib/prompt-firewall";
import { getEgressStats } from "@/lib/egress-controls";
import { getRecentAlerts } from "@/lib/behaviour-monitor";
import { getBrokerMetrics } from "@/lib/secret-broker";
import { prisma } from "@/lib/prisma";

/** GET /api/security — aggregated security dashboard data */
export async function GET(request: NextRequest) {
  const sinceHours = Number(request.nextUrl.searchParams.get("hours") ?? "24");

  const [
    killSwitchState,
    firewallStats,
    egressStats,
    recentAlerts,
    brokerMetrics,
    policyViolations,
    recentAuditEvents,
  ] = await Promise.all([
    getKillSwitchState(),
    getFirewallStats(sinceHours),
    getEgressStats(sinceHours),
    getRecentAlerts({ sinceHours, limit: 20 }),
    getBrokerMetrics(),
    prisma.auditEvent.count({
      where: {
        eventType: { startsWith: "policy." },
        createdAt: { gte: new Date(Date.now() - sinceHours * 60 * 60 * 1000) },
      },
    }),
    prisma.auditEvent.findMany({
      where: {
        eventType: {
          in: [
            "kill_switch.activated",
            "kill_switch.deactivated",
            "firewall.prompt.blocked",
            "firewall.prompt.escalated",
            "egress.blocked",
            "anomaly.credential_harvesting",
            "anomaly.mass_file_access",
            "anomaly.privilege_escalation",
            "anomaly.ssh_key_access",
            "anomaly.unusual_egress",
            "permission.check.denied",
            "permission.check.unauthorized",
          ],
        },
        createdAt: { gte: new Date(Date.now() - sinceHours * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        entityType: true,
        entityId: true,
        eventType: true,
        actorType: true,
        payload: true,
        createdAt: true,
      },
    }),
  ]);

  return NextResponse.json({
    killSwitch: killSwitchState,
    firewall: firewallStats,
    egress: egressStats,
    alerts: recentAlerts,
    secretBroker: brokerMetrics,
    policyViolations,
    recentEvents: recentAuditEvents,
    generatedAt: new Date().toISOString(),
    windowHours: sinceHours,
  });
}
