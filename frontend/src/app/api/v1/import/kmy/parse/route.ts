import type { NextRequest } from 'next/server';
import { forwardLargeUpload } from '@/lib/large-upload-proxy';

// Kept out of the proxy's matcher and streamed to the backend, so Next never
// buffers the body: see `LARGE_UPLOAD_ROUTES` in `src/lib/proxy-body-limit.ts`.
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest) {
  return forwardLargeUpload(request);
}
