import type { NextRequest } from "next/server";
import { forwardLargeUpload } from "@/lib/large-upload-proxy";

// Kept out of the proxy's matcher and streamed to the backend, so Next never
// buffers the body: see `LARGE_UPLOAD_ROUTES` in `src/lib/proxy-body-limit.ts`.
// The matcher excludes the path whatever the method, so the listing is
// forwarded from here as well.
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return forwardLargeUpload(request);
}

export function POST(request: NextRequest) {
  return forwardLargeUpload(request);
}
