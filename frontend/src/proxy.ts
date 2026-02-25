import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';

const logger = createLogger('Proxy');
const publicPaths = ['/login', '/register', '/auth/callback', '/forgot-password', '/reset-password'];
let backendConnected = false;

function buildCspHeader(nonce: string): string {
  const isDev = process.env.NODE_ENV !== 'production';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

function nextWithCsp(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCspHeader(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Handle API proxying to backend
  if (pathname.startsWith('/api/')) {
    const apiUrl = process.env.INTERNAL_API_URL || 'http://localhost:3001';
    const url = new URL(pathname + request.nextUrl.search, apiUrl);
    logger.debug(`${request.method} ${pathname} -> ${apiUrl}`);

    const headers = new Headers(request.headers);
    headers.delete('host');
    // Overwrite X-Forwarded-For with the actual connecting client IP
    // to prevent spoofing via client-supplied headers
    const clientIp = request.headers.get('x-real-ip') || '127.0.0.1';
    headers.set('x-forwarded-for', clientIp);

    try {
      const response = await fetch(url.toString(), {
        method: request.method,
        headers,
        body: request.body,
        redirect: 'manual',
        // @ts-expect-error - duplex is required for streaming bodies
        duplex: 'half',
      });

      if (!backendConnected) {
        backendConnected = true;
        logger.info(`Backend connected at ${apiUrl}`);
      }

      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('transfer-encoding');

      return new NextResponse(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      logger.error('API proxy error:', error);
      return NextResponse.json({ error: 'Backend unavailable' }, { status: 502 });
    }
  }

  // Handle auth redirects for non-API routes
  // Check for either access token or refresh token (access token expires in 15m,
  // but refresh token lasts 7 days — if present, the frontend will refresh transparently)
  const token = request.cookies.get('auth_token')?.value || request.cookies.get('refresh_token')?.value;

  // Allow public paths - don't redirect auth pages to dashboard based on cookie alone,
  // as the cookie may reference a deleted/inactive user. Let the client handle redirects.
  if (publicPaths.some(path => pathname.startsWith(path))) {
    return nextWithCsp(request);
  }

  // Protect all other routes
  if (!token) {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  return nextWithCsp(request);
}

export const config = {
  matcher: [
    // Match API routes for proxying
    '/api/:path*',
    // Match all other paths except static files
    '/((?!_next/static|_next/image|favicon.ico|.*\\..*|public).*)',
  ],
};
