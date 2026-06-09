import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import { validateSshKeyPath } from "../ssh-key-path";

const HOME = os.homedir();

describe("validateSshKeyPath", () => {
  // ── Valid paths ──────────────────────────────────────────────────────────────

  it("accepts ~/…ssh key path and returns absolute resolved path", () => {
    const result = validateSshKeyPath("~/.ssh/id_rsa");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved).toBe(path.join(HOME, ".ssh/id_rsa"));
  });

  it("accepts an absolute path within home directory", () => {
    const keyPath = path.join(HOME, ".ssh", "id_ed25519");
    const result = validateSshKeyPath(keyPath);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved).toBe(keyPath);
  });

  it("accepts a deeply nested path within home directory", () => {
    const keyPath = path.join(HOME, "keys", "prod", "server.pem");
    const result = validateSshKeyPath(keyPath);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved).toBe(keyPath);
  });

  // ── Path traversal attacks ───────────────────────────────────────────────────

  it("blocks /etc/passwd", () => {
    const result = validateSshKeyPath("/etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/home directory/);
  });

  it("blocks /etc/shadow", () => {
    const result = validateSshKeyPath("/etc/shadow");
    expect(result.ok).toBe(false);
  });

  it("blocks /proc/self/environ", () => {
    const result = validateSshKeyPath("/proc/self/environ");
    expect(result.ok).toBe(false);
  });

  it("blocks traversal that escapes home via ..", () => {
    const result = validateSshKeyPath(path.join(HOME, ".ssh", "..", "..", "etc", "passwd"));
    expect(result.ok).toBe(false);
  });

  it("blocks ~ traversal pattern like ~/.ssh/../../etc/passwd", () => {
    const result = validateSshKeyPath("~/.ssh/../../etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("blocks /root/.ssh/id_rsa when running as non-root", () => {
    if (HOME === "/root") return; // skip when actually running as root
    const result = validateSshKeyPath("/root/.ssh/id_rsa");
    expect(result.ok).toBe(false);
  });

  // ── Input validation ─────────────────────────────────────────────────────────

  it("rejects empty string", () => {
    const result = validateSshKeyPath("");
    expect(result.ok).toBe(false);
  });

  it("rejects whitespace-only string", () => {
    const result = validateSshKeyPath("   ");
    expect(result.ok).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(validateSshKeyPath(null).ok).toBe(false);
    expect(validateSshKeyPath(undefined).ok).toBe(false);
    expect(validateSshKeyPath(42).ok).toBe(false);
  });

  it("rejects path containing null byte", () => {
    const result = validateSshKeyPath(`${HOME}/.ssh/id_rsa\0etc/passwd`);
    expect(result.ok).toBe(false);
  });

  it("rejects relative path without ~/", () => {
    const result = validateSshKeyPath(".ssh/id_rsa");
    expect(result.ok).toBe(false);
  });
});
