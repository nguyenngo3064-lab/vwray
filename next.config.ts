import type { NextConfig } from "next";

/**
 * Control-plane Next.js configuration.
 *
 * This application is the CONTROL PLANE only. It never opens VPN sockets itself;
 * the data plane (WireGuard / Xray gateways) runs as a separate process reachable
 * over HTTP by the gateway agent protocol. See DEPLOYMENT.md.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `standalone` produces a minimal server bundle used by the production Dockerfile.
  output: "standalone",
  // Pure-JS server libraries are kept external so they are bundled by Node, not
  // by the Turbopack/Webpack server build. Both are CommonJS and dependency-free.
  serverExternalPackages: ["pdf-lib", "qrcode", "@prisma/client", "prisma"],
  eslint: {
    // Lint is run as its own CI step (`npm run lint`); failing the build here
    // would duplicate that work.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
