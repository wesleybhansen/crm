import type { NextConfig } from "next";
import path from "node:path";
import { browserSecurityHeaderRules } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  output: 'standalone',
  skipTrailingSlashRedirect: true,
  distDir: '.mercato/next',
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    serverMinification: false,
    turbopackMinify: false,
  },
  turbopack: {
    // Monorepo root is two levels up from apps/mercato
    root: path.resolve(process.cwd(), "../.."),
  },
  // Externalize packages that are only used in CLI context, not Next.js
  serverExternalPackages: [
    'esbuild',
    '@esbuild/darwin-arm64',
    '@open-mercato/cli',
  ],
  async headers() {
    return browserSecurityHeaderRules()
  },
}

export default nextConfig
