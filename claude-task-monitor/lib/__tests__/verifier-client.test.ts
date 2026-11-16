/**
 * Tests the HMAC signing contract against a minimal local HTTP server that
 * re-implements the same verification algorithm as
 * verifier-service/app/auth.py (Python), proving the two independent
 * implementations (Node signer, "Python" verifier re-created here in JS for
 * test purposes) actually agree on the wire format, without requiring a
 * real Python process in the unit-test suite. The genuine cross-language
 * round trip against the real FastAPI service is exercised manually via
 * scripts/demo-python-verifier.ts (see docs/architecture.md).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "http";
import { createHmac, timingSafeEqual } from "crypto";
import { callVerifierService, type VerifierRequest } from "../verifier-client";

const SECRET = "test-shared-secret";
const MAX_SKEW_SECONDS = 300;

let server: Server;
let baseUrl: string;
let lastReceivedBody: string | null = null;

function verifySignature(timestamp: string, signature: string, rawBody: string): boolean {
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > MAX_SKEW_SECONDS) return false;
  const expected = createHmac("sha256", SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      lastReceivedBody = data;
      const ts = req.headers["x-timestamp"] as string | undefined;
      const sig = req.headers["x-signature"] as string | undefined;
      if (!ts || !sig || !verifySignature(ts, sig, data)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid signature" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        task_id: JSON.parse(data).task_id,
        verification_state: "INDEPENDENTLY_VERIFIED",
        allowed: true,
        reasons: ["ok"],
        risk_flags: [],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  lastReceivedBody = null;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const SAMPLE_REQUEST: VerifierRequest = {
  task_id: "task-1",
  agent_reported_status: "passed",
  independent_results: [{ label: "test", command: "npm test", exit_code: 0 }],
  changed_files: [],
};

describe("callVerifierService", () => {
  it("returns null without making a network call when env vars are unset", async () => {
    delete process.env.VERIFIER_SERVICE_URL;
    delete process.env.VERIFIER_SHARED_SECRET;
    const result = await callVerifierService(SAMPLE_REQUEST);
    expect(result).toBeNull();
    expect(lastReceivedBody).toBeNull();
  });

  it("produces a signature the server independently verifies as valid", async () => {
    process.env.VERIFIER_SERVICE_URL = baseUrl;
    process.env.VERIFIER_SHARED_SECRET = SECRET;

    const result = await callVerifierService(SAMPLE_REQUEST);

    expect(result).toEqual({
      task_id: "task-1",
      verification_state: "INDEPENDENTLY_VERIFIED",
      allowed: true,
      reasons: ["ok"],
      risk_flags: [],
    });
    expect(JSON.parse(lastReceivedBody!)).toEqual(SAMPLE_REQUEST);
  });

  it("returns null (never throws) when the shared secret is wrong", async () => {
    process.env.VERIFIER_SERVICE_URL = baseUrl;
    process.env.VERIFIER_SHARED_SECRET = "wrong-secret";

    const result = await callVerifierService(SAMPLE_REQUEST);
    expect(result).toBeNull();
  });

  it("returns null when the service is unreachable", async () => {
    process.env.VERIFIER_SERVICE_URL = "http://127.0.0.1:1"; // nothing listens here
    process.env.VERIFIER_SHARED_SECRET = SECRET;

    const result = await callVerifierService(SAMPLE_REQUEST, { timeoutMs: 500 });
    expect(result).toBeNull();
  });
});
