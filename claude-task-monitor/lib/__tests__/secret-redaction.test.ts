/**
 * P3-5: Secret Leakage Prevention
 *
 * Verifies that the pane scrubber correctly redacts common secret patterns
 * from execution log text before it is persisted or served via the API.
 */

import { describe, it, expect } from "vitest";
import { scrubPaneCapture } from "../pane-scrubber";

describe("scrubPaneCapture — API key patterns", () => {
  it("redacts AWS Access Key IDs", () => {
    const text = "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
    expect(scrubPaneCapture(text)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts GitHub personal access tokens (classic)", () => {
    const text = "token ghp_1234567890abcdefghij12345678901234";
    const result = scrubPaneCapture(text);
    expect(result).not.toContain("ghp_1234567890");
  });

  it("redacts Bearer tokens", () => {
    const text = "Authorization: Bearer sk-ant-api03-abc123def456";
    const result = scrubPaneCapture(text);
    expect(result).not.toContain("sk-ant-api03-abc123def456");
  });

  it("redacts DATABASE_URL with embedded password", () => {
    const text = "DATABASE_URL=postgres://user:supersecretpassword@db.host/mydb";
    const result = scrubPaneCapture(text);
    expect(result).not.toContain("supersecretpassword");
  });

  it("redacts generic password= assignments", () => {
    const text = "connecting with password=my_super_secret_123";
    const result = scrubPaneCapture(text);
    expect(result).not.toContain("my_super_secret_123");
  });

  it("redacts generic token= assignments", () => {
    const text = "api_key=xabcdef1234567890abcdef1234";
    const result = scrubPaneCapture(text);
    expect(result).not.toContain("xabcdef1234567890abcdef1234");
  });
});

describe("scrubPaneCapture — known task secrets", () => {
  it("redacts a known secret value even if pattern does not match", () => {
    const knownSecret = "my-unique-secret-value-xyz";
    const text = `Using value: ${knownSecret} for authentication`;
    const result = scrubPaneCapture(text, [knownSecret]);
    expect(result).not.toContain(knownSecret);
    expect(result).toContain("[REDACTED]");
  });

  it("does not redact short values (< 4 chars)", () => {
    // Short known secrets are skipped to prevent false positives
    expect(scrubPaneCapture("hello world", ["hi"])).toContain("hello world");
    expect(scrubPaneCapture("hello abc world", ["abc"])).toBe("hello abc world");
  });
});

describe("scrubPaneCapture — safe content", () => {
  it("does not alter text with no secret patterns", () => {
    const text = "Claude completed the task successfully. Output: 42 items processed.";
    expect(scrubPaneCapture(text)).toBe(text);
  });

  it("replaces found patterns with [REDACTED]", () => {
    const text = "token=supersecretvalue123 and some other text";
    const result = scrubPaneCapture(text);
    expect(result).toContain("[REDACTED]");
  });
});
