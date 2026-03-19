const packageJson = require('./package.json');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone', // Optimized for Docker deployment
  serverExternalPackages: ['jspdf', 'jspdf-autotable', 'fflate'],
  poweredByHeader: false, // Remove X-Powered-By: Next.js header
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
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      );
    }
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
};

module.exports = nextConfig;
