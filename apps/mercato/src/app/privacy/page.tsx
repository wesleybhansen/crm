export const metadata = { title: 'Privacy Policy — LaunchOS CRM' }

export default function PrivacyPage() {
  const s = {
    page: { maxWidth: 800, margin: '0 auto', padding: '48px 24px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: '#333', lineHeight: 1.8 } as const,
    h1: { fontSize: 32, fontWeight: 700, marginBottom: 4, color: '#111' } as const,
    updated: { color: '#888', marginBottom: 40, fontSize: 14 } as const,
    h2: { fontSize: 20, fontWeight: 600, marginTop: 40, marginBottom: 12, color: '#111' } as const,
    h3: { fontSize: 16, fontWeight: 600, marginTop: 24, marginBottom: 8, color: '#222' } as const,
    p: { marginBottom: 16, fontSize: 15 } as const,
    ul: { marginBottom: 16, paddingLeft: 24, fontSize: 15 } as const,
    li: { marginBottom: 8 } as const,
    link: { color: '#0000CC', textDecoration: 'none' } as const,
    callout: { background: '#f8f9fa', border: '1px solid #e9ecef', borderRadius: 8, padding: '16px 20px', marginBottom: 20, fontSize: 14 } as const,
    footer: { marginTop: 56, paddingTop: 24, borderTop: '1px solid #eee', color: '#999', fontSize: 13 } as const,
  }

  return (
    <div style={s.page}>
      <h1 style={s.h1}>LaunchOS CRM — Privacy Policy</h1>
      <p style={s.updated}>Last updated: April 6, 2026</p>

      <div style={s.callout}>
        <strong>Company-Wide Privacy Policy:</strong> This policy covers the LaunchOS CRM platform specifically. For our company-wide privacy policy covering all Launchpad Incubator services, see <a href="https://thelaunchpadincubator.com/privacy/" style={s.link}>thelaunchpadincubator.com/privacy</a>.
      </div>

      <p style={s.p}>The Launch Pad LLC ("Company," "we," "our," "us") operates the LaunchOS CRM platform at crm.thelaunchpadincubator.com (the "Platform"). This Privacy Policy explains how we collect, use, store, share, and protect your information when you use the Platform. By accessing or using LaunchOS, you consent to the practices described in this policy.</p>

      <h2 style={s.h2}>1. Information We Collect</h2>

      <h3 style={s.h3}>1.1 Account Information</h3>
      <p style={s.p}>When you create an account, we collect your name, email address, and a password (stored as an irreversible bcrypt hash — we never store or see your actual password). If you join an organization, we may also collect your role and team information.</p>

      <h3 style={s.h3}>1.2 Business Information</h3>
      <p style={s.p}>During onboarding and through the Platform, you may provide your business name, type, description, website URL, logo, target audience, pipeline stages, and AI assistant preferences. This information is used to personalize your CRM experience.</p>

      <h3 style={s.h3}>1.3 CRM Data</h3>
      <p style={s.p}>You create and manage various business data within the Platform, including contacts, companies, deals, tasks, invoices, email messages, notes, tags, landing pages, funnels, forms, surveys, courses, booking pages, events, email campaigns, sequences, and automation rules. You own all CRM data you create.</p>

      <h3 style={s.h3}>1.4 Connected Third-Party Accounts</h3>
      <p style={s.p}>When you connect external services, we store OAuth access tokens and refresh tokens to act on your behalf. We never store your third-party passwords. Connected services may include:</p>
      <ul style={s.ul}>
        <li style={s.li}><strong>Google (Gmail, Calendar):</strong> OAuth tokens for email sending, inbox scanning, and calendar sync</li>
        <li style={s.li}><strong>Microsoft (Outlook):</strong> OAuth tokens for email sending and calendar sync</li>
        <li style={s.li}><strong>Stripe:</strong> Account connection for payment processing</li>
      </ul>

      <h3 style={s.h3}>1.5 Usage and Technical Data</h3>
      <p style={s.p}>We collect standard technical data including IP address, browser type, device information, pages visited, and timestamps. This data is used solely for security, debugging, and improving the Platform.</p>

      <h2 style={s.h2}>2. Google User Data — Limited Use Disclosure</h2>

      <div style={s.callout}>
        <strong>Google API Services User Data Policy Compliance:</strong> LaunchOS's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" style={s.link}>Google API Services User Data Policy</a>, including the Limited Use requirements.
      </div>

      <h3 style={s.h3}>2.1 What Google Data We Access</h3>
      <ul style={s.ul}>
        <li style={s.li}><strong>Gmail Send (gmail.send):</strong> Used to send emails on your behalf from your Gmail address — when you compose emails in the CRM, when automated email sequences fire, when reminders are sent, and when invoices are delivered.</li>
        <li style={s.li}><strong>Gmail Read-Only (gmail.readonly):</strong> Used for two optional features you control: (a) <em>Inbox Intelligence</em> — scans your inbox to detect new business contacts and update conversation history in the CRM; (b) <em>Brand Voice Engine</em> — analyzes your sent emails to learn your writing style so AI-drafted emails sound like you. Both features can be enabled or disabled in Settings.</li>
        <li style={s.li}><strong>Google Calendar API:</strong> Used to sync calendar events, create events from booking pages, and display your schedule within the Platform.</li>
        <li style={s.li}><strong>User Info (userinfo.email, openid):</strong> Used solely to identify your email address for account linking when you connect your Google account.</li>
      </ul>

      <h3 style={s.h3}>2.2 How We Use Google Data</h3>
      <p style={s.p}>We use Google data exclusively to provide the features described above. We do not use Google data for any other purpose. Specifically:</p>
      <ul style={s.ul}>
        <li style={s.li}>We <strong>do not</strong> sell, rent, or lease Google user data to any third party.</li>
        <li style={s.li}>We <strong>do not</strong> use Google user data for advertising, ad targeting, or to serve ads.</li>
        <li style={s.li}>We <strong>do not</strong> use Google user data to build user profiles for advertising purposes.</li>
        <li style={s.li}>We <strong>do not</strong> transfer Google user data to third parties except as necessary to provide or improve the Platform's user-facing features (e.g., passing email content to the AI model to generate a draft reply).</li>
        <li style={s.li}>We <strong>do not</strong> allow humans to read your Google data unless: (a) you give explicit, affirmative consent for a specific message; (b) it is necessary for security purposes such as investigating abuse; (c) it is necessary to comply with applicable law; or (d) the data has been aggregated and fully anonymized for internal operations.</li>
      </ul>

      <h3 style={s.h3}>2.3 Google Data Storage and Retention</h3>
      <p style={s.p}>Gmail OAuth tokens (access and refresh tokens) are stored encrypted in our database. Email message content processed by Inbox Intelligence is stored in the CRM as part of your contact communication history. Brand Voice analysis results are stored as an aggregate writing style profile — individual email texts are not permanently stored after analysis. You can disconnect Google at any time in Settings, which immediately revokes our access and deletes stored tokens.</p>

      <h2 style={s.h2}>3. AI and Third-Party Data Processing</h2>
      <p style={s.p}>LaunchOS uses AI services to power intelligent features. When you use these features, relevant context is sent to the AI provider to generate responses:</p>
      <ul style={s.ul}>
        <li style={s.li}><strong>Google Gemini:</strong> Powers email drafting, landing page copy generation, course content generation, brand voice analysis, inbox intelligence classification, and the Scout text assistant.</li>
        <li style={s.li}><strong>OpenAI:</strong> Powers the Scout voice assistant (speech-to-speech) and text-to-speech features.</li>
      </ul>
      <p style={s.p}>These providers process data according to their respective privacy policies and API terms of service. Data sent via API is not used to train their models. We send only the minimum context necessary for each feature to function.</p>

      <h2 style={s.h2}>4. How We Use Your Information</h2>
      <ul style={s.ul}>
        <li style={s.li}>To provide, operate, and maintain the LaunchOS CRM Platform</li>
        <li style={s.li}>To send emails, manage contacts, and process payments on your behalf</li>
        <li style={s.li}>To generate AI-powered content and recommendations</li>
        <li style={s.li}>To send you system notifications (reminders, alerts, digest emails)</li>
        <li style={s.li}>To detect and prevent fraud, abuse, and security incidents</li>
        <li style={s.li}>To improve the Platform, fix bugs, and develop new features</li>
        <li style={s.li}>To comply with legal obligations</li>
      </ul>

      <h2 style={s.h2}>5. Data Sharing</h2>
      <p style={s.p}>We do not sell, rent, or share your personal information with third parties for marketing or advertising purposes. We share data only in the following circumstances:</p>
      <ul style={s.ul}>
        <li style={s.li}><strong>Service Providers:</strong> Infrastructure hosting (Hetzner), email delivery (Resend), payment processing (Stripe), and AI services (Google, OpenAI) — each bound by their terms of service and privacy policies.</li>
        <li style={s.li}><strong>Legal Requirements:</strong> When required by law, subpoena, court order, or government request.</li>
        <li style={s.li}><strong>Safety:</strong> To protect the rights, safety, or property of the Company, our users, or the public.</li>
        <li style={s.li}><strong>Business Transfer:</strong> In connection with a merger, acquisition, or sale of assets, with notice to affected users.</li>
      </ul>

      <h2 style={s.h2}>6. Data Storage and Security</h2>
      <p style={s.p}>Your data is stored on servers hosted by Hetzner in Germany (EU). We implement the following security measures:</p>
      <ul style={s.ul}>
        <li style={s.li}>HTTPS/TLS encryption for all connections</li>
        <li style={s.li}>Tenant-level data encryption for sensitive fields (AES-256)</li>
        <li style={s.li}>Bcrypt password hashing with cost factor 10+</li>
        <li style={s.li}>OAuth tokens stored encrypted, never logged in plain text</li>
        <li style={s.li}>Rate limiting on authentication endpoints</li>
        <li style={s.li}>Role-based access control within organizations</li>
      </ul>
      <p style={s.p}>While we take reasonable measures to protect your data, no method of electronic storage or transmission is 100% secure. We cannot guarantee absolute security.</p>

      <h2 style={s.h2}>7. Your Rights and Choices</h2>

      <h3 style={s.h3}>7.1 All Users</h3>
      <ul style={s.ul}>
        <li style={s.li}><strong>Access:</strong> View all your data at any time through the Platform</li>
        <li style={s.li}><strong>Export:</strong> Export contacts and data via CSV at any time</li>
        <li style={s.li}><strong>Correction:</strong> Edit or update your information at any time</li>
        <li style={s.li}><strong>Deletion:</strong> Request deletion of your account and all associated data by contacting us</li>
        <li style={s.li}><strong>Disconnect:</strong> Revoke Gmail, Outlook, or Stripe access at any time in Settings</li>
        <li style={s.li}><strong>Google Revocation:</strong> Revoke Google access at <a href="https://myaccount.google.com/permissions" style={s.link}>Google Account Permissions</a></li>
        <li style={s.li}><strong>Feature Control:</strong> Enable or disable Inbox Intelligence, Brand Voice Engine, AI features, and email scanning independently in Settings</li>
      </ul>

      <h3 style={s.h3}>7.2 EEA/UK Residents (GDPR)</h3>
      <p style={s.p}>If you are located in the European Economic Area or United Kingdom, you have additional rights under the GDPR, including the right to access, rectify, erase, restrict processing, data portability, and to withdraw consent. To exercise these rights, contact us at the address below.</p>

      <h3 style={s.h3}>7.3 California Residents (CCPA/CPRA)</h3>
      <p style={s.p}>If you are a California resident, you have the right to know what personal information we collect, request deletion, request correction, and opt out of the sale of personal information (we do not sell personal information). To exercise these rights, contact us at the address below.</p>

      <h2 style={s.h2}>8. Data Retention</h2>
      <p style={s.p}>We retain your data for as long as your account is active or as needed to provide services. If you delete your account, we will delete or anonymize your data within 30 days, except where we are legally required to retain it (e.g., financial records, tax documentation). Backup copies may persist for up to 90 days before being fully purged.</p>

      <h2 style={s.h2}>9. Cookies</h2>
      <p style={s.p}>We use only essential cookies required for authentication and session management. We do not use third-party tracking cookies, analytics cookies, or advertising cookies on the Platform.</p>

      <h2 style={s.h2}>10. Children{"'"}s Privacy</h2>
      <p style={s.p}>LaunchOS is not directed to children under 13 (or under 16 in the EEA). We do not knowingly collect personal information from children. If we become aware that we have collected data from a child, we will delete it promptly.</p>

      <h2 style={s.h2}>11. International Data Transfers</h2>
      <p style={s.p}>Your data is stored on servers in Germany (EU). If you access the Platform from outside the EU, your data will be transferred to and processed in the EU. We rely on Hetzner{"'"}s GDPR-compliant infrastructure for data hosting.</p>

      <h2 style={s.h2}>12. Changes to This Policy</h2>
      <p style={s.p}>We may update this Privacy Policy from time to time. We will notify you of material changes via email or in-app notification at least 14 days before the changes take effect. The "Last updated" date at the top reflects the most recent revision.</p>

      <div style={s.footer}>
        <p>See also: <a href="https://thelaunchpadincubator.com/privacy/" style={s.link}>Company-Wide Privacy Policy</a> · <a href="/terms" style={s.link}>Terms of Service</a></p>
        <p style={{ marginTop: 8 }}><a href="/login" style={s.link}>← Back to LaunchOS</a></p>
      </div>
    </div>
  )
}
