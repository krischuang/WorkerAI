import { NextResponse } from "next/server";
import { getSourceFiles } from "@/lib/interview-live-demo";

export const dynamic = "force-dynamic";

/** GET /api/interview/live-comparison/source: the current disposable
 *  fixture's actual file contents, for the "View Source Code" button.
 *  Returns null fields if no run has been started yet. */
export async function GET() {
  const files = getSourceFiles();
  return NextResponse.json(
    files ?? { tasksApiJs: null, testJs: null, packageJson: null, requirementsMd: null, disclosure: null },
  );
}
