import type { Metadata } from 'next'
import { JetBrains_Mono } from 'next/font/google'
import { ClerkProvider } from '@clerk/nextjs'
import './globals.css'
import { bootstrap } from '@/bootstrap'
import { AppProviders } from '@/components/AppProviders'
import { noliClerkAppearance } from '@open-mercato/shared/lib/noli/appearance'

// Bootstrap all package registrations at module load time
bootstrap()
import { detectLocale, loadDictionary } from '@open-mercato/shared/lib/i18n/server'

// Satoshi (body/display) is not on Google Fonts; it loads via the Fontshare
// stylesheet <link> in <head> below, and globals.css maps --font-geist-sans
// to 'Satoshi' (variable name kept so nothing downstream changes).
const jetbrainsMono = JetBrains_Mono({
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
          <link
            rel="stylesheet"
            href="https://api.fontshare.com/v2/css?f[]=satoshi@300,400,500,600,700,800,900&display=swap"
          />
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
          {/* Preflight base resets, shipped verbatim in the document head. The
              production CSS minifier (lightningcss) strips Tailwind v4's bundled
              preflight (and any box-sizing / color:inherit rules authored in
              globals.css), which left anchors rendering as default blue/
              underlined links app-wide. An inline <style> bypasses the CSS
              pipeline, so these always apply. Element selectors stay lower
              specificity than utility classes, so they only restore base
              defaults and never override component styling. */}
          <style
            key="om-preflight"
            dangerouslySetInnerHTML={{
              __html:
                '*,::before,::after{box-sizing:border-box}' +
                'a{color:inherit;text-decoration:inherit}' +
                'body{margin:0;line-height:inherit}' +
                'h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit;margin:0}' +
                'p,figure,blockquote,dl,dd{margin:0}' +
                'ol,ul,menu{list-style:none;margin:0;padding:0}' +
                'button,[type=button],[type=reset],[type=submit]{cursor:pointer}' +
                ':disabled{cursor:default}' +
                'table{border-collapse:collapse}' +
                'img,svg,video,canvas,audio,iframe,embed,object{display:block;vertical-align:middle}' +
                'img,video{max-width:100%;height:auto}',
            }}
          />
        </head>
        <body className={`${jetbrainsMono.variable} antialiased`} suppressHydrationWarning data-gramm="false">
          <AppProviders locale={locale} dict={dict} demoModeEnabled={demoModeEnabled} posthogKey={posthogKey} posthogHost={posthogHost}>
            {children}
          </AppProviders>
        </body>
      </html>
    </ClerkProvider>
  );
}
