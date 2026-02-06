import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';

const logger = createLogger('Proxy');
const publicPaths = ['/login', '/register', '/auth/callback'];
let backendConnected = false;

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Handle API proxying to backend
  if (pathname.startsWith('/api/')) {
    const apiUrl = process.env.INTERNAL_API_URL || 'http://localhost:3001';
    const url = new URL(pathname + request.nextUrl.search, apiUrl);
    logger.debug(`${request.method} ${pathname} -> ${apiUrl}`);

    const headers = new Headers(request.headers);
    headers.delete('host');

    try {
      const response = await fetch(url.toString(), {
        method: request.method,
        headers,
        body: request.body,
        // @ts-expect-error - duplex is required for streaming bodies
        duplex: 'half',
      });

      if (!backendConnected) {
        backendConnected = true;
        console.info(`[Proxy] Backend connected at ${apiUrl}`);
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
  const token = request.cookies.get('auth_token')?.value;

  // Allow public paths - don't redirect auth pages to dashboard based on cookie alone,
  // as the cookie may reference a deleted/inactive user. Let the client handle redirects.
  if (publicPaths.some(path => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  // Protect all other routes
  if (!token) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match API routes for proxying
    '/api/:path*',
    // Match all other paths except static files
    '/((?!_next/static|_next/image|favicon.ico|.*\\..*|public).*)',
  ],
};
