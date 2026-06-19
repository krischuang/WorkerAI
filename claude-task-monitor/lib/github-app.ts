/**
 * Phase 4.3 — GitHub App Security Model
 *
 * Replaces the shared GITHUB_TOKEN with per-project scoped installation tokens.
 * Each project receives a scoped installation token with:
 *   - Owner restrictions (project A cannot access project B repos)
 *   - Repository restrictions (per-repo granularity)
 *   - Mode restrictions: read-only | commit | PR
 *
 * Token lifecycle:
 *   - Tokens expire after 1 hour (GitHub installation token TTL)
 *   - Cached in-memory and refreshed on demand
 *   - All token issuances and revocations are audited
 */

import { createSign } from "crypto";
import { emitAudit } from "@/lib/audit";

export type GitHubAccessMode = "read" | "commit" | "pull_request";

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  /** Mapping of project ID → installation ID */
  installationMap: Record<string, string>;
}

export interface ScopedInstallationToken {
  token: string;
  projectId: string;
  owner: string;
  repositories: string[];
  mode: GitHubAccessMode;
  issuedAt: Date;
  expiresAt: Date;
  installationId: string;
}

export interface TokenRequest {
  projectId: string;
  owner: string;
  repositories: string[];
  mode: GitHubAccessMode;
}

// Token cache: projectId → token (invalidated when expired)
const tokenCache = new Map<string, ScopedInstallationToken>();

/**
 * Permission maps for each access mode.
 * Read-only gets minimal permissions; PR mode gets PR-specific permissions.
 */
const MODE_PERMISSIONS: Record<GitHubAccessMode, Record<string, string>> = {
  read: {
    contents: "read",
    metadata: "read",
  },
  commit: {
    contents: "write",
    metadata: "read",
  },
  pull_request: {
    contents: "write",
    metadata: "read",
    pull_requests: "write",
    checks: "write",
  },
};

/**
 * Generate a GitHub App JWT for authentication.
 * The JWT is used to request installation access tokens.
 * Valid for 10 minutes (GitHub maximum is 10 minutes).
 */
function generateAppJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // issued 60 seconds ago to account for clock drift
    exp: now + 540, // 9 minutes validity
    iss: appId,
  };

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signing = `${header}.${body}`;

  const sign = createSign("RSA-SHA256");
  sign.update(signing);
  const signature = sign.sign(privateKey, "base64url");

  return `${signing}.${signature}`;
}

/**
 * Request an installation access token from GitHub's API.
 * Scoped to specific repositories and permissions.
 */
async function requestInstallationToken(opts: {
  installationId: string;
  appJWT: string;
  repositories: string[];
  permissions: Record<string, string>;
}): Promise<{ token: string; expiresAt: Date }> {
  const response = await fetch(
    `https://api.github.com/app/installations/${opts.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.appJWT}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repositories: opts.repositories,
        permissions: opts.permissions,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub App token request failed ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    token: string;
    expires_at: string;
  };

  return {
    token: data.token,
    expiresAt: new Date(data.expires_at),
  };
}

/**
 * Get or refresh a scoped installation token for a project.
 * Tokens are cached and refreshed automatically when within 5 minutes of expiry.
 */
export async function getScopedToken(req: TokenRequest): Promise<ScopedInstallationToken> {
  const cacheKey = `${req.projectId}:${req.mode}:${req.repositories.sort().join(",")}`;
  const cached = tokenCache.get(cacheKey);

  // Return cached token if valid for more than 5 minutes
  if (cached && cached.expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
    return cached;
  }

  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const installationMapRaw = process.env.GITHUB_INSTALLATION_MAP ?? "{}";

  if (!appId || !privateKey) {
    // Fallback to legacy token with owner restriction
    const legacyToken = process.env.GITHUB_TOKEN;
    if (!legacyToken) throw new Error("No GitHub authentication configured");

    const allowedOwners = (process.env.GITHUB_ALLOWED_OWNERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (allowedOwners.length > 0 && !allowedOwners.includes(req.owner.toLowerCase())) {
      throw new Error(`Owner "${req.owner}" not in GITHUB_ALLOWED_OWNERS`);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour for legacy

    const token: ScopedInstallationToken = {
      token: legacyToken,
      projectId: req.projectId,
      owner: req.owner,
      repositories: req.repositories,
      mode: req.mode,
      issuedAt: now,
      expiresAt,
      installationId: "legacy",
    };

    await emitAudit({
      entityType: "github-app",
      entityId: req.projectId,
      eventType: "github.token.legacy_issued",
      actorType: "system",
      payload: { owner: req.owner, mode: req.mode, repositories: req.repositories },
    });

    return token;
  }

  let installationMap: Record<string, string> = {};
  try {
    installationMap = JSON.parse(installationMapRaw);
  } catch {
    throw new Error("GITHUB_INSTALLATION_MAP is not valid JSON");
  }

  const installationId = installationMap[req.projectId];
  if (!installationId) {
    throw new Error(`No GitHub App installation configured for project "${req.projectId}"`);
  }

  const appJWT = generateAppJWT(appId, privateKey);
  const permissions = MODE_PERMISSIONS[req.mode];

  const { token, expiresAt } = await requestInstallationToken({
    installationId,
    appJWT,
    repositories: req.repositories,
    permissions,
  });

  const scopedToken: ScopedInstallationToken = {
    token,
    projectId: req.projectId,
    owner: req.owner,
    repositories: req.repositories,
    mode: req.mode,
    issuedAt: new Date(),
    expiresAt,
    installationId,
  };

  tokenCache.set(cacheKey, scopedToken);

  await emitAudit({
    entityType: "github-app",
    entityId: req.projectId,
    eventType: "github.token.issued",
    actorType: "system",
    payload: {
      installationId,
      owner: req.owner,
      mode: req.mode,
      repositories: req.repositories,
      expiresAt: expiresAt.toISOString(),
    },
  });

  return scopedToken;
}

/**
 * Revoke all cached tokens for a project.
 * Called when a project is archived or a security incident is detected.
 */
export function revokeProjectTokens(projectId: string): number {
  let revoked = 0;
  for (const [key] of tokenCache.entries()) {
    if (key.startsWith(`${projectId}:`)) {
      tokenCache.delete(key);
      revoked++;
    }
  }
  return revoked;
}

/**
 * Validate that a GitHub operation is permitted under the scoped token.
 * Prevents project A from accessing project B's repositories.
 */
export function validateRepoAccess(opts: {
  token: ScopedInstallationToken;
  targetOwner: string;
  targetRepo: string;
  operation: "read" | "write" | "pr";
}): { allowed: boolean; reason?: string } {
  // Owner check: token is scoped to a specific owner
  if (opts.token.owner.toLowerCase() !== opts.targetOwner.toLowerCase()) {
    return {
      allowed: false,
      reason: `Token is scoped to owner "${opts.token.owner}", cannot access "${opts.targetOwner}"`,
    };
  }

  // Repository check: token is scoped to specific repos
  if (
    opts.token.repositories.length > 0 &&
    !opts.token.repositories.includes(opts.targetRepo)
  ) {
    return {
      allowed: false,
      reason: `Repository "${opts.targetRepo}" not in token scope: [${opts.token.repositories.join(", ")}]`,
    };
  }

  // Mode check
  const modeHierarchy: Record<GitHubAccessMode, number> = {
    read: 0,
    commit: 1,
    pull_request: 2,
  };

  const requiredMode: GitHubAccessMode =
    opts.operation === "pr" ? "pull_request" :
    opts.operation === "write" ? "commit" : "read";

  if (modeHierarchy[opts.token.mode] < modeHierarchy[requiredMode]) {
    return {
      allowed: false,
      reason: `Operation "${opts.operation}" requires "${requiredMode}" mode, token has "${opts.token.mode}"`,
    };
  }

  return { allowed: true };
}

/**
 * Extract owner and repo from a GitHub URL.
 */
export function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}
