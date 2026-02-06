/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone', // Optimized for Docker deployment
  env: {
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL || 'http://localhost:3000',
  },
  // API proxying is handled by middleware.ts at runtime
  // This allows INTERNAL_API_URL to be set at container start, not build time
};

module.exports = nextConfig;
