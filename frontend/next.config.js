const createNextIntlPlugin = require('next-intl/plugin');
const packageJson = require('./package.json');

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the dev (Turbopack) workspace root to this app so it doesn't scan the
  // whole monorepo (the backend tree) on every compile. The repo has multiple
  // lockfiles, which otherwise makes Next infer the monorepo root and slows
  // on-demand route compilation in dev.
  turbopack: { root: __dirname },
  output: 'standalone', // Optimized for Docker deployment
  serverExternalPackages: ['jspdf', 'jspdf-autotable', 'fflate'],
  poweredByHeader: false, // Remove X-Powered-By: Next.js header
  serverExternalPackages: ['jspdf'],
  env: {
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL || 'http://localhost:3000',
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
  },
  // API proxying and CSP are handled by proxy.ts at runtime
  // This allows INTERNAL_API_URL to be set at container start, not build time
  async headers() {
    const disableHttpsHeaders = process.env.DISABLE_HTTPS_HEADERS === 'true';
    const securityHeaders = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      // CSP is set dynamically in proxy.ts with per-request nonces
      { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
    ];
    if (!disableHttpsHeaders) {
      securityHeaders.push(
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        // COOP + COEP enable cross-origin isolation. Every subresource is
        // same-origin (CSP is default-src 'self'; img/font allow only self,
        // data:, blob:) and already carries Cross-Origin-Resource-Policy:
        // same-origin, so require-corp loads cleanly without external opt-ins.
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
      );
    }
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
};

module.exports = withNextIntl(nextConfig);
