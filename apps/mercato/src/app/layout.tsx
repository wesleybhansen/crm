import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { Geist_Mono } from 'next/font/google'
import { ClerkProvider } from '@clerk/nextjs'
import './globals.css'
import { bootstrap } from '@/bootstrap'
import { AppProviders } from '@/components/AppProviders'
import { noliClerkAppearance } from '@open-mercato/shared/lib/noli/appearance'

// Bootstrap all package registrations at module load time
bootstrap()
import { detectLocale, loadDictionary } from '@open-mercato/shared/lib/i18n/server'

const inter = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: 'Noli CRM',
  description: 'The all-in-one operating system for your business',
  icons: {
    icon: '/icon.svg',
  },
  manifest: '/manifest.webmanifest',
}

// ClerkProvider needs NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY at instantiation,
// which during static prerender means at build time. The Hetzner Docker
// build doesn't have access to runtime env vars during `yarn build`, so
// any prerendered page (e.g. /_not-found) crashes with "Missing
// publishableKey". Forcing the layout to render at runtime avoids this
// without restructuring the Dockerfile to plumb through build args.
// CRM is an internal app with very low request rate; per-request
// rendering is a non-issue here.
export const dynamic = 'force-dynamic'

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await detectLocale()
  const dict = await loadDictionary(locale)
  const demoModeEnabled = process.env.DEMO_MODE !== 'false'
  // Read PostHog config at runtime (force-dynamic) and thread to the client
  // provider as props — the Docker build has no NEXT_PUBLIC_* vars to inline.
  const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY
  const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST
  return (
    <ClerkProvider appearance={noliClerkAppearance}>
      <html lang={locale} suppressHydrationWarning>
        <head>
          <script
            key="om-theme-init"
            dangerouslySetInnerHTML={{
              __html: `
                (function() {
                  try {
                    var stored = localStorage.getItem('om-theme');
                    var theme = stored === 'dark' ? 'dark'
                      : stored === 'light' ? 'light'
                      : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                    if (theme === 'dark') document.documentElement.classList.add('dark');
                  } catch (e) {}
                })();
              `,
            }}
          />
        </head>
        <body className={`${inter.variable} ${geistMono.variable} antialiased`} suppressHydrationWarning data-gramm="false">
          <AppProviders locale={locale} dict={dict} demoModeEnabled={demoModeEnabled} posthogKey={posthogKey} posthogHost={posthogHost}>
            {children}
          </AppProviders>
        </body>
      </html>
    </ClerkProvider>
  );
}
