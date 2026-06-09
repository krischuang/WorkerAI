import { describe, it, expect } from "vitest";
import {
  isLocalOrigin,
  isDestructiveCommand,
  MAX_COMMAND_LENGTH,
} from "../exec-guards";

// ─── isLocalOrigin ────────────────────────────────────────────────────────────

describe("isLocalOrigin", () => {
  it("allows null (no Origin header — direct/server-side call)", () => {
    expect(isLocalOrigin(null)).toBe(true);
  });

  it("allows localhost with any port", () => {
    expect(isLocalOrigin("http://localhost:3000")).toBe(true);
    expect(isLocalOrigin("http://localhost")).toBe(true);
    expect(isLocalOrigin("http://localhost:8080")).toBe(true);
  });

  it("allows 127.0.0.1", () => {
    expect(isLocalOrigin("http://127.0.0.1:3000")).toBe(true);
  });

  it("allows ::1 (IPv6 loopback — Node URL wraps it as [::1])", () => {
    expect(isLocalOrigin("http://[::1]:3000")).toBe(true);
  });

  it("blocks a foreign origin", () => {
    expect(isLocalOrigin("https://evil.example.com")).toBe(false);
  });

  it("blocks a localhost-prefixed domain (common SSRF bypass)", () => {
    expect(isLocalOrigin("https://localhost.evil.com")).toBe(false);
  });

  it("blocks an origin containing 'localhost' as a subdomain", () => {
    expect(isLocalOrigin("http://my.localhost.attacker.com")).toBe(false);
  });

  it("blocks an unparseable origin string", () => {
    expect(isLocalOrigin("not-a-url")).toBe(false);
    expect(isLocalOrigin("://bad")).toBe(false);
  });
});

// ─── isDestructiveCommand ────────────────────────────────────────────────────

describe("isDestructiveCommand — blocked patterns", () => {
  it("blocks 'rm -rf /'", () => {
    expect(isDestructiveCommand("rm -rf /")).toBe(true);
  });

  it("blocks 'rm -fr /' (reversed flags)", () => {
    expect(isDestructiveCommand("rm -fr /")).toBe(true);
  });

  it("blocks 'rm -Rf /' (uppercase R)", () => {
    expect(isDestructiveCommand("rm -Rf /")).toBe(true);
  });

  it("blocks mkfs variants", () => {
    expect(isDestructiveCommand("mkfs.ext4 /dev/sdb1")).toBe(true);
    expect(isDestructiveCommand("mkfs -t ext4 /dev/sdb")).toBe(true);
  });

  it("blocks dd writing to a raw disk device", () => {
    expect(isDestructiveCommand("dd if=/dev/zero of=/dev/sda")).toBe(true);
    expect(isDestructiveCommand("dd bs=4M if=/dev/zero of=/dev/nvme0n1")).toBe(true);
  });

  it("blocks the classic fork bomb", () => {
    expect(isDestructiveCommand(":(){:|:&};:")).toBe(true);
  });

  it("blocks shred on a disk device", () => {
    expect(isDestructiveCommand("shred -n 3 /dev/sdb")).toBe(true);
  });

  it("blocks wipefs on a disk device", () => {
    expect(isDestructiveCommand("wipefs -a /dev/sda")).toBe(true);
  });
});

describe("isDestructiveCommand — allowed patterns", () => {
  it("allows rm on a specific file path", () => {
    expect(isDestructiveCommand("rm /tmp/oldfile.log")).toBe(false);
  });

  it("allows rm -rf on a scoped path (not root)", () => {
    expect(isDestructiveCommand("rm -rf /tmp/build")).toBe(false);
    expect(isDestructiveCommand("rm -rf ./dist")).toBe(false);
  });

  it("allows normal dd usage not targeting a block device", () => {
    expect(isDestructiveCommand("dd if=/dev/urandom of=/tmp/random.bin bs=1M count=1")).toBe(false);
  });

  it("allows grep, ls, cat, and other read-only commands", () => {
    expect(isDestructiveCommand("grep -r TODO /app/src")).toBe(false);
    expect(isDestructiveCommand("ls -la /")).toBe(false);
    expect(isDestructiveCommand("cat /etc/hostname")).toBe(false);
  });

  it("allows package manager commands", () => {
    expect(isDestructiveCommand("npm install")).toBe(false);
    expect(isDestructiveCommand("dnf update -y")).toBe(false);
  });

  it("allows long commands up to the length limit", () => {
    const cmd = "echo " + "x".repeat(MAX_COMMAND_LENGTH - 10);
    expect(isDestructiveCommand(cmd)).toBe(false);
  });
});

// ─── MAX_COMMAND_LENGTH ───────────────────────────────────────────────────────

describe("MAX_COMMAND_LENGTH", () => {
  it("is 4096", () => {
    expect(MAX_COMMAND_LENGTH).toBe(4096);
  });
});
