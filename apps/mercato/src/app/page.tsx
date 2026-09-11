import { StartPageContent } from '@/components/StartPageContent'
import type { Metadata } from 'next'
import { resolveLocalizedAppMetadata } from '@/lib/metadata'
import { cookies } from 'next/headers'
import Image from 'next/image'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return resolveLocalizedAppMetadata()
}

/*
 * The unauthenticated root. It is a sign-in pointer and nothing else. It must
 * not expose the module list, the database status, or links into the example
 * module: that module is disabled, so every one of those links 404s, and the
 * counts are tenant data no signed-out visitor should see.
 */
export default async function Home() {
  const { t } = await resolveTranslations()

  const cookieStore = await cookies()
  const showStartPageCookie = cookieStore.get('show_start_page')
  const showStartPage = showStartPageCookie?.value !== 'false'

  const onboardingAvailable =
    process.env.SELF_SERVICE_ONBOARDING_ENABLED === 'true' &&
    Boolean(process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim()) &&
    Boolean(process.env.APP_URL && process.env.APP_URL.trim())

  return (
    <main className="min-h-svh w-full p-8 flex flex-col gap-8">
      <header className="flex flex-col md:flex-row md:items-center gap-4 md:gap-6">
        <Image
          src="/noli-logo.svg"
          alt={t('app.page.logoAlt', 'Noli CRM')}
          width={40}
          height={40}
          priority
        />
        <div className="flex-1">
          <h1 className="text-3xl font-semibold tracking-tight">{t('app.page.title', 'Noli CRM')}</h1>
          <p className="text-sm text-muted-foreground">{t('app.page.signIn', 'Sign in at app.noliai.com.')}</p>
        </div>
        <a
          className="underline text-[#1d4ed8] dark:text-[#60a5fa] hover:opacity-80 transition-colors text-sm"
          href="https://app.noliai.com/sign-in"
        >
          {t('app.page.quickLinks.login', 'Login')}
        </a>
      </header>

      <StartPageContent showStartPage={showStartPage} showOnboardingCta={onboardingAvailable} />
    </main>
  )
}
