import { describe, it, expect } from "vitest";
import {
  getClaudeLaunchCommand,
  PERMISSION_MODE_LABEL,
  PERMISSION_MODE_DESCRIPTION,
} from "../ssh-claude-tmux";

describe("getClaudeLaunchCommand", () => {
  it("read_only mode — launches with a restricted tools allowlist", () => {
    const cmd = getClaudeLaunchCommand("read_only");
    expect(cmd).toContain("--allowedTools");
    expect(cmd).toContain("Read");
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });

  it("workspace_write mode — launches plain claude with no extra flags", () => {
    expect(getClaudeLaunchCommand("workspace_write")).toBe("claude");
  });

  it("full_autonomous mode — launches with dangerously-skip-permissions", () => {
    const cmd = getClaudeLaunchCommand("full_autonomous");
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("--allowedTools");
  });
});

describe("PERMISSION_MODE_LABEL", () => {
  it("has a label for every mode", () => {
    expect(PERMISSION_MODE_LABEL.read_only).toBeTruthy();
    expect(PERMISSION_MODE_LABEL.workspace_write).toBeTruthy();
    expect(PERMISSION_MODE_LABEL.full_autonomous).toBeTruthy();
  });
});

describe("PERMISSION_MODE_DESCRIPTION", () => {
  it("has a description for every mode", () => {
    expect(PERMISSION_MODE_DESCRIPTION.read_only.length).toBeGreaterThan(0);
    expect(PERMISSION_MODE_DESCRIPTION.workspace_write.length).toBeGreaterThan(0);
    expect(PERMISSION_MODE_DESCRIPTION.full_autonomous.length).toBeGreaterThan(0);
  });
});
