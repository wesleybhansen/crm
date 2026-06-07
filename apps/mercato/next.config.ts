import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: 'standalone',
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
  // Legal pages are consolidated to the canonical company-wide pages on
  // noliai.com (single source of truth — no per-app drift). The Google
  // Limited Use disclosure now lives on noliai.com/privacy.
  async redirects() {
    return [
      { source: '/terms', destination: 'https://noliai.com/terms', permanent: false },
      { source: '/privacy', destination: 'https://noliai.com/privacy', permanent: false },
    ]
  },
}

export default nextConfig
