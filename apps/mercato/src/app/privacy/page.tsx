export const metadata = { title: 'Privacy Policy — LaunchOS' }

export default function PrivacyPage() {
  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '40px 24px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: '#333', lineHeight: 1.7 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Privacy Policy</h1>
      <p style={{ color: '#666', marginBottom: 32 }}>Last updated: April 5, 2026</p>

      <p>LaunchOS ("we", "our", "us") operates the LaunchOS CRM platform at crm.thelaunchpadincubator.com. This Privacy Policy explains how we collect, use, and protect your information.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>1. Information We Collect</h2>
      <p><strong>Account Information:</strong> When you sign up, we collect your name, email address, and password (stored as a bcrypt hash).</p>
      <p><strong>Business Information:</strong> Business name, description, type, website URL, and other profile details you provide during onboarding.</p>
      <p><strong>CRM Data:</strong> Contacts, deals, tasks, invoices, email messages, notes, and other business data you create within the platform.</p>
      <p><strong>Connected Accounts:</strong> When you connect Gmail, Outlook, or Stripe, we store OAuth tokens to act on your behalf. We do not store your Google, Microsoft, or Stripe passwords.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>2. Google User Data</h2>
      <p>When you connect your Google account, LaunchOS requests access to:</p>
      <ul>
        <li><strong>Gmail Send (gmail.send):</strong> To send emails on your behalf from your Gmail address when you compose emails in the CRM or when automated sequences/reminders are triggered.</li>
        <li><strong>Gmail Read (gmail.readonly):</strong> To scan your inbox for new contacts and conversation history (Inbox Intelligence feature), and to analyze your writing style (Brand Voice Engine). You control these features in Settings.</li>
        <li><strong>Google Calendar:</strong> To sync calendar events and enable booking page functionality.</li>
        <li><strong>User Info:</strong> To identify your email address for account linking.</li>
      </ul>
      <p><strong>Limited Use Disclosure:</strong> LaunchOS's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" style={{ color: '#0000CC' }}>Google API Services User Data Policy</a>, including the Limited Use requirements. Specifically:</p>
      <ul>
        <li>We only use Google data for the features described above (sending email, inbox scanning, calendar sync, voice analysis).</li>
        <li>We do not transfer Google user data to third parties except as necessary to provide the service (e.g., displaying your sent email in the CRM).</li>
        <li>We do not use Google user data for advertising or to serve ads.</li>
        <li>We do not allow humans to read your Google data unless (a) you give explicit consent, (b) it's necessary for security purposes, (c) it's required by law, or (d) the data is aggregated and anonymized for internal operations.</li>
      </ul>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>3. How We Use Your Information</h2>
      <ul>
        <li>To provide and operate the LaunchOS CRM platform</li>
        <li>To send emails, manage contacts, and process payments on your behalf</li>
        <li>To generate AI-powered features (email drafts, landing page copy, voice analysis) using third-party AI providers (Google Gemini, OpenAI)</li>
        <li>To send you system notifications (reminders, alerts)</li>
        <li>To improve the platform and fix bugs</li>
      </ul>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>4. AI and Third-Party Services</h2>
      <p>LaunchOS uses AI services (Google Gemini, OpenAI) to power features like email drafting, landing page copy generation, and voice analysis. When you use these features, relevant context (business info, contact names, email content) is sent to these providers to generate responses. These providers process data according to their own privacy policies and do not use your data to train their models when accessed via API.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>5. Data Storage and Security</h2>
      <p>Your data is stored on secure servers hosted by Hetzner in the EU/Germany. We use:</p>
      <ul>
        <li>Encrypted database connections (SSL/TLS)</li>
        <li>Tenant-level data encryption for sensitive fields</li>
        <li>Bcrypt password hashing (cost factor 10+)</li>
        <li>OAuth tokens stored encrypted, never in plain text logs</li>
        <li>HTTPS for all connections</li>
      </ul>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>6. Data Sharing</h2>
      <p>We do not sell, rent, or share your personal information with third parties for marketing purposes. We share data only:</p>
      <ul>
        <li>With service providers that help operate the platform (hosting, email delivery, payment processing)</li>
        <li>When required by law or legal process</li>
        <li>To protect the rights, safety, or property of LaunchOS or its users</li>
      </ul>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>7. Your Rights</h2>
      <p>You can:</p>
      <ul>
        <li><strong>Access</strong> your data at any time through the platform</li>
        <li><strong>Export</strong> your contacts and data via CSV export</li>
        <li><strong>Delete</strong> your account and all associated data by contacting us</li>
        <li><strong>Disconnect</strong> Gmail, Outlook, or Stripe at any time in Settings, which revokes our access</li>
        <li><strong>Revoke</strong> Google access at <a href="https://myaccount.google.com/permissions" style={{ color: '#0000CC' }}>Google Account Permissions</a></li>
      </ul>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>8. Data Retention</h2>
      <p>We retain your data for as long as your account is active. If you delete your account, we delete your data within 30 days, except where we are required by law to retain it.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>9. Cookies</h2>
      <p>We use essential cookies for authentication (session tokens). We do not use tracking cookies, analytics cookies, or advertising cookies.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>10. Changes to This Policy</h2>
      <p>We may update this Privacy Policy from time to time. We will notify you of significant changes via email or in-app notification.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>11. Contact</h2>
      <p>For privacy questions or data requests, contact:</p>
      <p>Wesley Hansen<br />Email: wesley.b.hansen@gmail.com<br />LaunchOS — The Launchpad Incubator</p>

      <div style={{ marginTop: 48, paddingTop: 24, borderTop: '1px solid #eee', color: '#999', fontSize: 13 }}>
        <a href="/login" style={{ color: '#0000CC' }}>Back to LaunchOS</a>
      </div>
    </div>
  )
}
