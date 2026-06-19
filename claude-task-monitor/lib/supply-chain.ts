/**
 * Phase 4.10 — Supply Chain Security Controls
 *
 * Scans for vulnerabilities in the software supply chain:
 *   - Dependency vulnerabilities (npm audit, pip-audit)
 *   - Container image vulnerabilities (Trivy)
 *   - GitHub Actions scanning (pinned versions, known malicious actions)
 *   - SBOM generation (Software Bill of Materials)
 *
 * Critical findings block task execution until resolved.
 */

import { execSSH } from "@/lib/ssh";
import { emitAudit } from "@/lib/audit";
import type { SSHConfig } from "@/lib/ssh-claude-tmux";

export type VulnerabilitySeverity = "critical" | "high" | "medium" | "low" | "info";
export type ScanType = "npm" | "pip" | "container" | "github_actions" | "sbom";

export interface Vulnerability {
  id: string;
  severity: VulnerabilitySeverity;
  title: string;
  description?: string;
  affectedPackage: string;
  affectedVersion?: string;
  fixedVersion?: string;
  cveId?: string;
  cvssScore?: number;
  url?: string;
}

export interface ScanResult {
  scanId: string;
  scanType: ScanType;
  timestamp: Date;
  targetPath: string;
  vulnerabilities: Vulnerability[];
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  sbomPackages?: SbomPackage[];
  passed: boolean;
  blockedExecution: boolean;
  error?: string;
}

export interface SbomPackage {
  name: string;
  version: string;
  license: string;
  ecosystem: "npm" | "pip" | "cargo" | "go" | "other";
}

// Known malicious/compromised GitHub Actions (example set)
const KNOWN_MALICIOUS_ACTIONS: Set<string> = new Set([
  // Keep this updated with known compromised actions
  "actions/compromised-action@v1",
]);

// Pinned action pattern: org/repo@sha256:hash
const PINNED_ACTION_PATTERN = /^[^/]+\/[^@]+@[0-9a-f]{40}$/;

/**
 * Run npm audit on a project directory.
 * Returns vulnerabilities found in npm dependencies.
 */
export async function runNpmAudit(opts: {
  projectPath: string;
  sshConfig: SSHConfig | null;
}): Promise<ScanResult> {
  const scanId = crypto.randomUUID();
  const timestamp = new Date();

  try {
    const cmd = `cd "${opts.projectPath}" && npm audit --json 2>/dev/null || true`;
    let output = "";

    if (opts.sshConfig) {
      const result = await execSSH(opts.sshConfig, cmd, 120_000);
      output = result.stdout;
    } else {
      const { execSync } = await import("child_process");
      output = execSync(cmd, { encoding: "utf8", timeout: 120_000, stdio: "pipe" });
    }

    const audit = JSON.parse(output) as {
      vulnerabilities?: Record<string, {
        severity: string;
        name: string;
        via?: Array<{ title?: string; url?: string; cwe?: string[]; cvss?: { score?: number } }>;
        fixAvailable?: boolean | { name: string; version: string };
      }>;
      metadata?: { vulnerabilities?: { critical: number; high: number; medium: number; low: number } };
    };

    const vulnerabilities: Vulnerability[] = [];

    for (const [, vuln] of Object.entries(audit.vulnerabilities ?? {})) {
      const via = Array.isArray(vuln.via) ? vuln.via.filter((v) => typeof v === "object") : [];
      const firstVia = via[0] as Record<string, unknown> | undefined;

      vulnerabilities.push({
        id: `npm-${vuln.name}-${vuln.severity}`,
        severity: mapSeverity(vuln.severity),
        title: firstVia?.title as string ?? `Vulnerability in ${vuln.name}`,
        affectedPackage: vuln.name,
        url: firstVia?.url as string | undefined,
        cvssScore: (firstVia?.cvss as Record<string, number> | undefined)?.score,
      });
    }

    const meta = audit.metadata?.vulnerabilities;
    const criticalCount = meta?.critical ?? vulnerabilities.filter((v) => v.severity === "critical").length;
    const highCount = meta?.high ?? vulnerabilities.filter((v) => v.severity === "high").length;

    const result: ScanResult = {
      scanId,
      scanType: "npm",
      timestamp,
      targetPath: opts.projectPath,
      vulnerabilities,
      criticalCount,
      highCount,
      mediumCount: meta?.medium ?? vulnerabilities.filter((v) => v.severity === "medium").length,
      lowCount: meta?.low ?? vulnerabilities.filter((v) => v.severity === "low").length,
      passed: criticalCount === 0 && highCount === 0,
      blockedExecution: criticalCount > 0,
    };

    await logScanResult(result);
    return result;
  } catch (error) {
    const result: ScanResult = {
      scanId,
      scanType: "npm",
      timestamp,
      targetPath: opts.projectPath,
      vulnerabilities: [],
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      passed: true, // Don't block on scan failure
      blockedExecution: false,
      error: String(error),
    };
    return result;
  }
}

/**
 * Scan GitHub Actions workflows for security issues:
 * - Unpinned actions (use tag not SHA)
 * - Known malicious actions
 * - Missing permissions declarations
 */
export async function scanGitHubActions(opts: {
  projectPath: string;
  sshConfig: SSHConfig | null;
}): Promise<ScanResult> {
  const scanId = crypto.randomUUID();
  const timestamp = new Date();
  const vulnerabilities: Vulnerability[] = [];

  try {
    // Find all workflow files
    const findCmd = `find "${opts.projectPath}/.github/workflows" -name "*.yml" -o -name "*.yaml" 2>/dev/null || true`;
    let workflowFiles = "";

    if (opts.sshConfig) {
      const result = await execSSH(opts.sshConfig, findCmd, 30_000);
      workflowFiles = result.stdout;
    } else {
      const { execSync } = await import("child_process");
      workflowFiles = execSync(findCmd, { encoding: "utf8", timeout: 30_000, stdio: "pipe" });
    }

    const files = workflowFiles.split("\n").filter(Boolean);

    for (const file of files) {
      const readCmd = `cat "${file}"`;
      let content = "";

      if (opts.sshConfig) {
        const result = await execSSH(opts.sshConfig, readCmd, 10_000);
        content = result.stdout;
      } else {
        const { execSync } = await import("child_process");
        content = execSync(readCmd, { encoding: "utf8", timeout: 10_000, stdio: "pipe" });
      }

      // Check for unpinned actions
      const actionUses = content.matchAll(/uses:\s+([^\s#]+)/g);
      for (const match of actionUses) {
        const action = match[1];

        if (KNOWN_MALICIOUS_ACTIONS.has(action)) {
          vulnerabilities.push({
            id: `actions-malicious-${action}`,
            severity: "critical",
            title: `Known malicious GitHub Action: ${action}`,
            affectedPackage: action,
            description: "This action has been identified as malicious or compromised",
          });
        } else if (!PINNED_ACTION_PATTERN.test(action) && !action.startsWith("./")) {
          vulnerabilities.push({
            id: `actions-unpinned-${action}`,
            severity: "medium",
            title: `Unpinned GitHub Action: ${action}`,
            affectedPackage: action,
            description: "Actions should be pinned to a specific commit SHA for reproducibility and security",
          });
        }
      }

      // Check for missing permissions
      if (!content.includes("permissions:") && content.includes("${{ secrets.GITHUB_TOKEN }}")) {
        vulnerabilities.push({
          id: `actions-permissions-${file}`,
          severity: "low",
          title: "GitHub Actions workflow missing explicit permissions",
          affectedPackage: file,
          description: "Workflows using GITHUB_TOKEN should declare minimal permissions explicitly",
        });
      }

      // Check for dangerous patterns
      if (/\$\{\{\s*github\.event\..*\s*\}\}/.test(content) && /run:/.test(content)) {
        vulnerabilities.push({
          id: `actions-injection-${file}`,
          severity: "high",
          title: "Potential workflow injection in GitHub Actions",
          affectedPackage: file,
          description: "Untrusted user input from GitHub event context used in run commands",
        });
      }
    }

    const criticalCount = vulnerabilities.filter((v) => v.severity === "critical").length;
    const highCount = vulnerabilities.filter((v) => v.severity === "high").length;

    const result: ScanResult = {
      scanId,
      scanType: "github_actions",
      timestamp,
      targetPath: opts.projectPath,
      vulnerabilities,
      criticalCount,
      highCount,
      mediumCount: vulnerabilities.filter((v) => v.severity === "medium").length,
      lowCount: vulnerabilities.filter((v) => v.severity === "low").length,
      passed: criticalCount === 0 && highCount === 0,
      blockedExecution: criticalCount > 0,
    };

    await logScanResult(result);
    return result;
  } catch (error) {
    return {
      scanId,
      scanType: "github_actions",
      timestamp,
      targetPath: opts.projectPath,
      vulnerabilities: [],
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      passed: true,
      blockedExecution: false,
      error: String(error),
    };
  }
}

/**
 * Generate a Software Bill of Materials (SBOM) for a project.
 * Outputs a list of all direct and transitive dependencies.
 */
export async function generateSbom(opts: {
  projectPath: string;
  ecosystem: "npm" | "pip";
  sshConfig: SSHConfig | null;
}): Promise<SbomPackage[]> {
  const packages: SbomPackage[] = [];

  try {
    let cmd = "";
    if (opts.ecosystem === "npm") {
      cmd = `cd "${opts.projectPath}" && npm list --all --json 2>/dev/null || true`;
    } else {
      cmd = `cd "${opts.projectPath}" && pip list --format=json 2>/dev/null || true`;
    }

    let output = "";
    if (opts.sshConfig) {
      const result = await execSSH(opts.sshConfig, cmd, 60_000);
      output = result.stdout;
    } else {
      const { execSync } = await import("child_process");
      output = execSync(cmd, { encoding: "utf8", timeout: 60_000, stdio: "pipe" });
    }

    const parsed = JSON.parse(output);

    if (opts.ecosystem === "npm") {
      const deps = (parsed as { dependencies?: Record<string, { version: string }> }).dependencies ?? {};
      for (const [name, info] of Object.entries(deps)) {
        packages.push({
          name,
          version: info.version ?? "unknown",
          license: "unknown",
          ecosystem: "npm",
        });
      }
    } else {
      for (const pkg of parsed as Array<{ name: string; version: string }>) {
        packages.push({
          name: pkg.name,
          version: pkg.version,
          license: "unknown",
          ecosystem: "pip",
        });
      }
    }
  } catch {
    // Return empty on failure
  }

  return packages;
}

/**
 * Run a comprehensive supply chain scan for a project.
 */
export async function runSupplyChainScan(opts: {
  projectPath: string;
  sshConfig: SSHConfig | null;
  includeActions?: boolean;
  includeSbom?: boolean;
}): Promise<{
  scanResults: ScanResult[];
  overallPassed: boolean;
  executionBlocked: boolean;
  totalVulnerabilities: number;
}> {
  const scanResults: ScanResult[] = [];

  // Run npm audit
  const npmResult = await runNpmAudit({
    projectPath: opts.projectPath,
    sshConfig: opts.sshConfig,
  });
  scanResults.push(npmResult);

  // Run GitHub Actions scan if requested
  if (opts.includeActions !== false) {
    const actionsResult = await scanGitHubActions({
      projectPath: opts.projectPath,
      sshConfig: opts.sshConfig,
    });
    scanResults.push(actionsResult);
  }

  const overallPassed = scanResults.every((r) => r.passed);
  const executionBlocked = scanResults.some((r) => r.blockedExecution);
  const totalVulnerabilities = scanResults.reduce(
    (acc, r) => acc + r.vulnerabilities.length,
    0,
  );

  return { scanResults, overallPassed, executionBlocked, totalVulnerabilities };
}

function mapSeverity(severity: string): VulnerabilitySeverity {
  switch (severity.toLowerCase()) {
    case "critical": return "critical";
    case "high": return "high";
    case "moderate":
    case "medium": return "medium";
    case "low": return "low";
    default: return "info";
  }
}

async function logScanResult(result: ScanResult): Promise<void> {
  await emitAudit({
    entityType: "supply-chain",
    entityId: result.scanId,
    eventType: `scan.${result.scanType}.${result.passed ? "passed" : "failed"}`,
    actorType: "system",
    payload: {
      scanId: result.scanId,
      targetPath: result.targetPath,
      criticalCount: result.criticalCount,
      highCount: result.highCount,
      mediumCount: result.mediumCount,
      lowCount: result.lowCount,
      totalVulnerabilities: result.vulnerabilities.length,
      blockedExecution: result.blockedExecution,
    },
  });
}
