import { serverError } from "@/lib/api-error";
import { sendTestEmail } from "@/lib/email";

export async function POST() {
  try {
    await sendTestEmail();
    return Response.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[test-email] Failed:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
