/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone', // Optimized for Docker deployment
  env: {
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL || 'http://localhost:3000',
  },
  async rewrites() {
    // INTERNAL_API_URL: Backend URL for server-side (K8s service DNS or docker network)
    const apiUrl = process.env.INTERNAL_API_URL || 'http://localhost:3001';
    return [
      {
        source: '/api/:path*',
        destination: `${apiUrl}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
