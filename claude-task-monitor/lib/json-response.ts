/**
 * BigInt-safe JSON response helper.
 *
 * `Response.json()` uses `JSON.stringify()` which throws on BigInt values.
 * The Server and Agent models have `diskUsedBytes` / `diskTotalBytes` as
 * BigInt fields. Use this helper everywhere those models are serialised.
 *
 * BigInt values are converted to Number. Disk sizes in bytes fit safely
 * within Number.MAX_SAFE_INTEGER (≈9 PB) for any realistic disk.
 */
export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  const body = JSON.stringify(data, (_key, value) =>
    typeof value === "bigint" ? Number(value) : value
  );
  return new Response(body, {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}
