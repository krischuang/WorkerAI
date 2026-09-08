"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Shield, ShieldAlert, ShieldOff, ShieldCheck,
  AlertTriangle, Eye, Lock, WifiOff,
  Activity, RefreshCw, Power, PowerOff,
  Flame, Key, Network,
} from "lucide-react";
import { PageHeader, Btn } from "@/app/_components/ui";

type KillSwitchReason =
  | "security_incident"
  | "prompt_injection"
  | "agent_compromise"
  | "credential_leak"
  | "manual_stop"
  | "maintenance"
  | "anomaly_detected";

interface KillSwitchScope {
  taskDispatch: boolean;
  selfHealing: boolean;
  autoCommit: boolean;
  autoPush: boolean;
  agentExecution: boolean;
}

interface KillSwitchState {
  active: boolean;
  reason?: KillSwitchReason;
  detail?: string;
  activatedAt?: string;
  activatedBy?: string;
  scope: KillSwitchScope;
}

interface KillSwitchHistoryEntry {
  eventType: string;
  reason?: string;
  activatedBy?: string;
  detail?: string;
  timestamp: string;
}

interface FirewallStats {
  blocked: number;
  escalated: number;
  sanitized: number;
  total: number;
}

interface EgressStats {
  blocked: number;
  blockedHosts: Record<string, number>;
}

interface AnomalyAlert {
  alertId: string;
  taskId: string;
  anomalyType: string;
  severity: string;
  description: string;
  detectedAt: string;
}

interface BrokerMetrics {
  activeCredentials: number;
  expiredCredentials: number;
  revokedCredentials: number;
}

interface SecurityAuditEvent {
  id: string;
  entityType: string;
  entityId: string;
  eventType: string;
  actorType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface SecurityData {
  killSwitch: KillSwitchState;
  firewall: FirewallStats;
  egress: EgressStats;
  alerts: AnomalyAlert[];
  secretBroker: BrokerMetrics;
  policyViolations: number;
  recentEvents: SecurityAuditEvent[];
  generatedAt: string;
  windowHours: number;
}

interface KillSwitchResponse {
  state: KillSwitchState;
  history: KillSwitchHistoryEntry[];
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950",
  high: "text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950",
  medium: "text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-950",
  low: "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950",
};

const EVENT_LABELS: Record<string, string> = {
  "kill_switch.activated": "Kill Switch Activated",
  "kill_switch.deactivated": "Kill Switch Deactivated",
  "firewall.prompt.blocked": "Prompt Blocked",
  "firewall.prompt.escalated": "Prompt Escalated",
  "egress.blocked": "Egress Blocked",
  "anomaly.credential_harvesting": "Credential Harvesting Detected",
  "anomaly.mass_file_access": "Mass File Access Detected",
  "anomaly.privilege_escalation": "Privilege Escalation Detected",
  "anomaly.ssh_key_access": "SSH Key Access Attempt",
  "anomaly.unusual_egress": "Unusual Egress Detected",
  "permission.check.denied": "Permission Denied",
  "permission.check.unauthorized": "Unauthorized Permission Check",
};

function StatCard({
  icon,
  label,
  value,
  sub,
  variant = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  variant?: "default" | "danger" | "warning" | "success";
}) {
  const colors = {
    default: "border-zinc-200 dark:border-zinc-700",
    danger: "border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950",
    warning: "border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-950",
    success: "border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950",
  }[variant];

  return (
    <div className={`rounded-lg border p-4 ${colors}`}>
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
          {label}
        </span>
      </div>
      <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{value}</div>
      {sub && <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{sub}</div>}
    </div>
  );
}

export default function SecurityPage() {
  const [data, setData] = useState<SecurityData | null>(null);
  const [ksHistory, setKsHistory] = useState<KillSwitchHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activating, setActivating] = useState(false);
  const [windowHours, setWindowHours] = useState(24);
  const [killReason, setKillReason] = useState<KillSwitchReason>("manual_stop");
  const [killDetail, setKillDetail] = useState("");
  const [showKillConfirm, setShowKillConfirm] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [secRes, ksRes] = await Promise.all([
        fetch(`/api/security?hours=${windowHours}`),
        fetch("/api/admin/kill-switch"),
      ]);
      if (secRes.ok) setData(await secRes.json());
      if (ksRes.ok) {
        const ksData: KillSwitchResponse = await ksRes.json();
        if (data) {
          setData((prev) => prev ? { ...prev, killSwitch: ksData.state } : prev);
        }
        setKsHistory(ksData.history ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [windowHours, data]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15_000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowHours]);

  async function toggleKillSwitch() {
    if (!data) return;
    setActivating(true);
    try {
      const isActive = data.killSwitch.active;
      const body = isActive
        ? { action: "deactivate", detail: "Manually deactivated via security dashboard" }
        : { action: "activate", reason: killReason, detail: killDetail || undefined };

      const res = await fetch("/api/admin/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const { state } = (await res.json()) as { state: KillSwitchState };
        setData((prev) => prev ? { ...prev, killSwitch: state } : prev);
        setShowKillConfirm(false);
        setKillDetail("");
        await fetchData();
      }
    } finally {
      setActivating(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <PageHeader title="Security Operations" />
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-zinc-200 dark:bg-zinc-800 rounded w-48" />
          <div className="grid grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-24 bg-zinc-200 dark:bg-zinc-800 rounded" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const ks = data?.killSwitch;
  const isKillActive = ks?.active ?? false;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-8">
      <div className="flex items-center justify-between">
        <PageHeader title="Security Operations" />
        <div className="flex items-center gap-3">
          <select
            className="text-sm border rounded px-2 py-1 bg-white dark:bg-zinc-800 dark:border-zinc-700"
            value={windowHours}
            onChange={(e) => setWindowHours(Number(e.target.value))}
          >
            <option value={1}>Last 1h</option>
            <option value={6}>Last 6h</option>
            <option value={24}>Last 24h</option>
            <option value={72}>Last 3d</option>
            <option value={168}>Last 7d</option>
          </select>
          <Btn size="sm" onClick={fetchData}>
            <RefreshCw size={14} className="mr-1" />
            Refresh
          </Btn>
        </div>
      </div>

      {/* Kill Switch Banner */}
      {isKillActive && (
        <div className="flex items-center gap-3 rounded-lg bg-red-600 text-white px-6 py-4">
          <ShieldOff size={24} />
          <div className="flex-1">
            <div className="font-bold text-lg">PLATFORM KILL SWITCH ACTIVE</div>
            <div className="text-sm opacity-90">
              Reason: {ks?.reason ?? "unknown"} — {ks?.detail ?? "No detail provided"}
            </div>
            <div className="text-xs opacity-75 mt-0.5">
              Activated {ks?.activatedAt ? new Date(ks.activatedAt).toLocaleString() : ""}
              {ks?.activatedBy ? ` by ${ks.activatedBy}` : ""}
            </div>
          </div>
          <Btn
            size="sm"
            className="bg-white text-red-600 hover:bg-red-50"
            onClick={() => setShowKillConfirm(true)}
            disabled={activating}
          >
            <Power size={14} className="mr-1" />
            Deactivate
          </Btn>
        </div>
      )}

      {/* Kill Switch Controls */}
      <section className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Power size={18} className={isKillActive ? "text-red-500" : "text-zinc-400"} />
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Platform Kill Switch</h2>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
            isKillActive
              ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
              : "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
          }`}>
            {isKillActive ? "ACTIVE" : "INACTIVE"}
          </span>
        </div>

        {!isKillActive && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-zinc-500 dark:text-zinc-400 mb-1 block">Reason</label>
                <select
                  className="w-full text-sm border rounded px-2 py-1.5 bg-white dark:bg-zinc-800 dark:border-zinc-700"
                  value={killReason}
                  onChange={(e) => setKillReason(e.target.value as KillSwitchReason)}
                >
                  <option value="security_incident">Security Incident</option>
                  <option value="prompt_injection">Prompt Injection Detected</option>
                  <option value="agent_compromise">Agent Compromised</option>
                  <option value="credential_leak">Credential Leak</option>
                  <option value="manual_stop">Manual Stop</option>
                  <option value="maintenance">Maintenance</option>
                  <option value="anomaly_detected">Anomaly Detected</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-zinc-500 dark:text-zinc-400 mb-1 block">Detail (optional)</label>
                <input
                  type="text"
                  className="w-full text-sm border rounded px-2 py-1.5 bg-white dark:bg-zinc-800 dark:border-zinc-700"
                  placeholder="Brief description..."
                  value={killDetail}
                  onChange={(e) => setKillDetail(e.target.value)}
                />
              </div>
            </div>
            <Btn
              variant="danger"
              onClick={() => setShowKillConfirm(true)}
              disabled={activating}
              className="flex items-center gap-2"
            >
              <PowerOff size={16} />
              Activate Kill Switch
            </Btn>
          </div>
        )}

        {isKillActive && (
          <div className="space-y-3">
            <div className="grid grid-cols-5 gap-2">
              {ks && Object.entries(ks.scope).map(([key, value]) => (
                <div
                  key={key}
                  className={`text-xs rounded p-2 text-center ${
                    value
                      ? "bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300"
                      : "bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300"
                  }`}
                >
                  <div className="font-medium">{value ? "HALTED" : "ACTIVE"}</div>
                  <div className="mt-0.5 opacity-75">{key.replace(/([A-Z])/g, " $1").trim()}</div>
                </div>
              ))}
            </div>
            <Btn onClick={() => setShowKillConfirm(true)} disabled={activating}>
              <Power size={14} className="mr-1" />
              Deactivate Kill Switch
            </Btn>
          </div>
        )}
      </section>

      {/* Kill Switch Confirm Modal */}
      {showKillConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-zinc-900 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              {isKillActive ? (
                <Power size={24} className="text-green-500" />
              ) : (
                <PowerOff size={24} className="text-red-500" />
              )}
              <h3 className="font-bold text-lg">
                {isKillActive ? "Deactivate Kill Switch?" : "Activate Kill Switch?"}
              </h3>
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
              {isKillActive
                ? "This will resume all platform operations including task dispatch, agent execution, self-healing, and auto-commit."
                : `This will immediately halt all agent execution, task dispatch, self-healing, auto-commit, and auto-push. Reason: ${killReason}.`}
            </p>
            <div className="flex gap-3 justify-end">
              <Btn
                size="sm"
                onClick={() => setShowKillConfirm(false)}
              >
                Cancel
              </Btn>
              <Btn
                size="sm"
                variant={isKillActive ? "secondary" : "danger"}
                onClick={toggleKillSwitch}
                disabled={activating}
              >
                {activating ? "Processing..." : isKillActive ? "Deactivate" : "Activate"}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {/* Security Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={<Flame size={16} className="text-red-500" />}
          label="Prompts Blocked"
          value={data?.firewall.blocked ?? 0}
          sub={`${data?.firewall.escalated ?? 0} escalated`}
          variant={data && data.firewall.blocked > 0 ? "danger" : "default"}
        />
        <StatCard
          icon={<Network size={16} className="text-orange-500" />}
          label="Egress Blocked"
          value={data?.egress.blocked ?? 0}
          sub={`${Object.keys(data?.egress.blockedHosts ?? {}).length} unique hosts`}
          variant={data && data.egress.blocked > 0 ? "warning" : "default"}
        />
        <StatCard
          icon={<AlertTriangle size={16} className="text-yellow-500" />}
          label="Anomaly Alerts"
          value={data?.alerts.length ?? 0}
          sub={`last ${windowHours}h`}
          variant={data && data.alerts.length > 0 ? "warning" : "default"}
        />
        <StatCard
          icon={<Key size={16} className="text-blue-500" />}
          label="Active Credentials"
          value={data?.secretBroker.activeCredentials ?? 0}
          sub={`${data?.secretBroker.revokedCredentials ?? 0} revoked`}
          variant="default"
        />
        <StatCard
          icon={<Eye size={16} className="text-purple-500" />}
          label="Policy Violations"
          value={data?.policyViolations ?? 0}
          sub={`last ${windowHours}h`}
          variant={data && data.policyViolations > 0 ? "warning" : "default"}
        />
        <StatCard
          icon={isKillActive ? <ShieldOff size={16} className="text-red-500" /> : <ShieldCheck size={16} className="text-green-500" />}
          label="Kill Switch"
          value={isKillActive ? "ACTIVE" : "INACTIVE"}
          sub={ks?.reason ?? ""}
          variant={isKillActive ? "danger" : "success"}
        />
        <StatCard
          icon={<Lock size={16} className="text-zinc-500" />}
          label="Credentials Issued"
          value={(data?.secretBroker.activeCredentials ?? 0) + (data?.secretBroker.expiredCredentials ?? 0) + (data?.secretBroker.revokedCredentials ?? 0)}
          sub="total session"
          variant="default"
        />
        <StatCard
          icon={<Activity size={16} className="text-zinc-500" />}
          label="Security Events"
          value={data?.recentEvents.length ?? 0}
          sub={`last ${windowHours}h`}
          variant="default"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Anomaly Alerts */}
        <section className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-6">
          <div className="flex items-center gap-2 mb-4">
            <AlertTriangle size={16} className="text-yellow-500" />
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Anomaly Alerts</h2>
          </div>
          {data?.alerts.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No anomalies detected in the last {windowHours}h.</p>
          ) : (
            <div className="space-y-2">
              {data?.alerts.map((alert) => (
                <div
                  key={alert.alertId}
                  className={`rounded p-3 text-xs ${SEVERITY_COLORS[alert.severity] ?? "bg-zinc-50 dark:bg-zinc-800"}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold capitalize">{alert.anomalyType.replace(/_/g, " ")}</span>
                    <span className="font-medium uppercase">{alert.severity}</span>
                  </div>
                  <div className="opacity-90">{alert.description}</div>
                  <div className="opacity-60 mt-1">
                    Task: {alert.taskId.slice(0, 8)} — {new Date(alert.detectedAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Blocked Egress Hosts */}
        <section className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-6">
          <div className="flex items-center gap-2 mb-4">
            <WifiOff size={16} className="text-red-500" />
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Blocked Egress</h2>
          </div>
          {Object.keys(data?.egress.blockedHosts ?? {}).length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No blocked egress in the last {windowHours}h.</p>
          ) : (
            <div className="space-y-1">
              {Object.entries(data?.egress.blockedHosts ?? {})
                .sort(([, a], [, b]) => b - a)
                .slice(0, 10)
                .map(([host, count]) => (
                  <div key={host} className="flex items-center justify-between text-sm py-1 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
                    <span className="font-mono text-xs">{host}</span>
                    <span className="text-xs text-red-600 dark:text-red-400 font-medium">{count}x blocked</span>
                  </div>
                ))}
            </div>
          )}
        </section>

        {/* Recent Security Events */}
        <section className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-6 lg:col-span-2">
          <div className="flex items-center gap-2 mb-4">
            <Shield size={16} className="text-zinc-500" />
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Recent Security Events</h2>
          </div>
          {data?.recentEvents.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No security events in the last {windowHours}h.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-700">
                    <th className="text-left pb-2 pr-4">Time</th>
                    <th className="text-left pb-2 pr-4">Event</th>
                    <th className="text-left pb-2 pr-4">Entity</th>
                    <th className="text-left pb-2">Actor</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.recentEvents.map((event) => (
                    <tr
                      key={event.id}
                      className="border-b border-zinc-100 dark:border-zinc-800 last:border-0"
                    >
                      <td className="py-1.5 pr-4 text-zinc-400 whitespace-nowrap">
                        {new Date(event.createdAt).toLocaleTimeString()}
                      </td>
                      <td className="py-1.5 pr-4 font-medium">
                        {EVENT_LABELS[event.eventType] ?? event.eventType}
                      </td>
                      <td className="py-1.5 pr-4 font-mono text-zinc-500">
                        {event.entityId.slice(0, 12)}
                      </td>
                      <td className="py-1.5 text-zinc-400 capitalize">
                        {event.actorType}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Kill Switch History */}
        <section className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-6 lg:col-span-2">
          <div className="flex items-center gap-2 mb-4">
            <ShieldAlert size={16} className="text-red-500" />
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Kill Switch History</h2>
          </div>
          {ksHistory.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No kill switch activations recorded.</p>
          ) : (
            <div className="space-y-2">
              {ksHistory.map((entry, i) => (
                <div key={i} className={`flex items-center gap-4 text-sm py-2 border-b border-zinc-100 dark:border-zinc-800 last:border-0`}>
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    entry.eventType === "kill_switch.activated" ? "bg-red-500" : "bg-green-500"
                  }`} />
                  <div className="flex-1">
                    <span className="font-medium capitalize">
                      {entry.eventType === "kill_switch.activated" ? "Activated" : "Deactivated"}
                    </span>
                    {entry.reason && (
                      <span className="text-zinc-500 dark:text-zinc-400 ml-2">
                        ({entry.reason.replace(/_/g, " ")})
                      </span>
                    )}
                    {entry.detail && (
                      <span className="text-zinc-400 ml-2 text-xs">— {entry.detail}</span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-400">
                    {entry.activatedBy && <span className="mr-2">by {entry.activatedBy}</span>}
                    {new Date(entry.timestamp).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="text-xs text-zinc-400 text-center">
        Last updated: {data?.generatedAt ? new Date(data.generatedAt).toLocaleString() : "—"} ·
        Auto-refreshes every 15 seconds
      </div>
    </div>
  );
}
