import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import fs from "fs";

type Ctx = { params: Promise<{ id: string; artifactId: string }> };

// Types that are safe to serve with their declared MIME type.
// Anything that a browser could execute (HTML, JS, SVG, XML, etc.) is excluded
// and will be served as application/octet-stream instead, forcing a download.
const SAFE_MIME_TYPES = new Set([
  "application/json",
  "application/octet-stream",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "text/csv",
  "text/plain",
]);

function safeMimeType(declared: string): string {
  const base = declared.split(";")[0].trim().toLowerCase();
  return SAFE_MIME_TYPES.has(base) ? base : "application/octet-stream";
}

export async function GET(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { id, artifactId } = await ctx.params;

  const artifact = await prisma.taskArtifact.findUnique({
    where: { id: artifactId },
    select: { id: true, taskId: true, filename: true, mimeType: true, storagePath: true },
  });

  if (!artifact || artifact.taskId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!fs.existsSync(artifact.storagePath)) {
    return NextResponse.json({ error: "File not found on disk" }, { status: 404 });
  }

  const buffer = fs.readFileSync(artifact.storagePath);

  // Sanitize the user-supplied filename to prevent header injection.
  // The fallback ASCII name strips any character that could be used to
  // inject CRLF sequences or break the quoted-string syntax.
  // The RFC 5987 encoded parameter (filename*) carries the full Unicode
  // name safely for modern clients while the ASCII fallback serves older ones.
  const safeAscii = artifact.filename
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "_") // disallow leading dots
    .slice(0, 255) || "download";
  const contentDisposition =
    `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`;

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": safeMimeType(artifact.mimeType),
      "Content-Disposition": contentDisposition,
      "Content-Length": String(buffer.length),
      "Cache-Control": "private, no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
