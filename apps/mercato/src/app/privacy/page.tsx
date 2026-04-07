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
        <strong>Incorporation of Company-Wide Privacy Policy:</strong> <a href="https://thelaunchpadincubator.com/privacy/" style={s.link}>The Launch Pad LLC Privacy Policy</a> is expressly incorporated into and made a part of this policy by reference. All terms and provisions of the company-wide privacy policy apply to your use of the LaunchOS CRM platform, except where they directly conflict with the terms set forth in this document, in which case the terms of this document shall control with respect to the Platform.
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

      <h2 style={s.h2}>5. Data Sharing and Subprocessors</h2>
      <p style={s.p}>We do not sell, rent, or share your personal information with third parties for marketing or advertising purposes. We share data only in the following circumstances:</p>
      <ul style={s.ul}>
        <li style={s.li}><strong>Subprocessors and Service Providers:</strong> Vendors that process data on our behalf to operate the Platform (see Section 5.1 for the full list)</li>
        <li style={s.li}><strong>Legal Requirements:</strong> When required by law, subpoena, court order, or government request</li>
        <li style={s.li}><strong>Safety:</strong> To protect the rights, safety, or property of the Company, our users, or the public</li>
        <li style={s.li}><strong>Business Transfer:</strong> In connection with a merger, acquisition, sale of assets, financing, or bankruptcy proceeding, with notice to affected users where legally required</li>
        <li style={s.li}><strong>With Your Consent:</strong> When you explicitly authorize sharing for specific purposes</li>
      </ul>

      <h3 style={s.h3}>5.1 Subprocessor List</h3>
      <p style={s.p}>The Company uses the following third-party service providers ("subprocessors") to operate the Platform. Each subprocessor processes user data only as needed to provide its specific service and is bound by its own terms of service and privacy policy:</p>
      <ul style={s.ul}>
        <li style={s.li}><strong>Hetzner Online GmbH</strong> (Germany) — Infrastructure hosting, server hosting, database storage. Data is stored in EU data centers.</li>
        <li style={s.li}><strong>Google LLC</strong> (United States) — Gemini AI API for AI-powered features (email drafting, content generation, brand voice analysis, voice assistant). Google OAuth for Gmail and Google Calendar integration.</li>
        <li style={s.li}><strong>OpenAI, L.L.C.</strong> (United States) — Realtime API for the Scout voice assistant (speech-to-speech), text-to-speech, and other voice-related features.</li>
        <li style={s.li}><strong>Anthropic, PBC</strong> (United States) — May be used for certain AI features and Model Context Protocol (MCP) integrations.</li>
        <li style={s.li}><strong>Resend, Inc.</strong> (United States) — Transactional and notification email delivery (reminders, system notifications, fallback for user emails when Gmail is unavailable).</li>
        <li style={s.li}><strong>Stripe, Inc.</strong> (United States) — Payment processing for invoices, subscriptions, and funnel checkouts. Stripe processes payment card data directly; the Company does not store credit card information.</li>
        <li style={s.li}><strong>Microsoft Corporation</strong> (United States) — Outlook OAuth integration (when users connect Microsoft accounts).</li>
      </ul>
      <p style={s.p}>The list of subprocessors may change over time. We will update this list when subprocessors are added, removed, or replaced. Material changes to subprocessors will be communicated via in-app notification or email.</p>

      <h3 style={s.h3}>5.2 International Data Transfers to Subprocessors</h3>
      <p style={s.p}>Some subprocessors are located in the United States. When data is transferred outside the European Economic Area, we rely on appropriate safeguards including Standard Contractual Clauses (SCCs) and the EU-U.S. Data Privacy Framework where applicable. By using the Platform, you consent to international data transfers as necessary to operate the service.</p>

      <h3 style={s.h3}>5.3 Data Processing Agreement (DPA)</h3>
      <p style={s.p}>If you process personal data of EU/EEA residents through the Platform and require a Data Processing Agreement under GDPR Article 28, contact us at <a href="mailto:privacy@thelaunchpadincubator.com" style={s.link}>privacy@thelaunchpadincubator.com</a> to request our standard DPA. Use of the Platform constitutes acceptance of our standard DPA terms with respect to data you process about EU/EEA residents.</p>

      <h2 style={s.h2}>6. Data Storage, Security, and Breach Notification</h2>

      <h3 style={s.h3}>6.1 Data Storage Location</h3>
      <p style={s.p}>Your data is stored on servers hosted by Hetzner Online GmbH in Germany (European Union). Some data may be transferred to subprocessors located in the United States as described in Section 5.</p>

      <h3 style={s.h3}>6.2 Security Measures</h3>
      <p style={s.p}>We implement reasonable technical and organizational security measures to protect your data, including:</p>
      <ul style={s.ul}>
        <li style={s.li}>HTTPS/TLS encryption for all connections in transit</li>
        <li style={s.li}>Tenant-level data encryption for sensitive fields (AES-256)</li>
        <li style={s.li}>Bcrypt password hashing with cost factor 10 or higher</li>
        <li style={s.li}>OAuth tokens stored encrypted, never logged in plain text</li>
        <li style={s.li}>Rate limiting on authentication endpoints</li>
        <li style={s.li}>Role-based access control within organizations</li>
        <li style={s.li}>Regular security updates to dependencies and infrastructure</li>
        <li style={s.li}>Restricted access to production systems on a need-to-know basis</li>
      </ul>
      <p style={s.p}>While we take reasonable measures to protect your data, no method of electronic storage or transmission is 100% secure. We cannot guarantee absolute security against all threats, and you acknowledge that you provide your data at your own risk.</p>

      <h3 style={s.h3}>6.3 Data Breach Notification</h3>
      <p style={s.p}>In the event of a data breach affecting your personal information, the Company will:</p>
      <ul style={s.ul}>
        <li style={s.li}>Investigate the incident promptly upon discovery</li>
        <li style={s.li}>Take reasonable steps to contain and mitigate the breach</li>
        <li style={s.li}>Notify affected users without undue delay, and where feasible within 72 hours of becoming aware of a breach that is likely to result in a risk to your rights and freedoms (consistent with GDPR Article 33)</li>
        <li style={s.li}>Notify applicable regulators as required by law</li>
        <li style={s.li}>Provide information about the nature of the breach, the data affected, the likely consequences, and the measures taken</li>
      </ul>
      <p style={s.p}>You are responsible for promptly notifying the Company of any actual or suspected breach of your account or unauthorized access to your data.</p>

      <h2 style={s.h2}>7. Your Responsibility for Protecting Your Data</h2>
      <p style={s.p}>While the Company implements reasonable security measures, you are ultimately responsible for protecting your account, your data, and any information you share with the Platform or with AI features accessed through the Platform.</p>
      <p style={s.p}>You agree that you are solely responsible for:</p>
      <ul style={s.ul}>
        <li style={s.li}>Maintaining the confidentiality of your login credentials, API keys, OAuth tokens, and other authentication information</li>
        <li style={s.li}>All activity that occurs under your account</li>
        <li style={s.li}>Notifying us promptly of any actual or suspected unauthorized access</li>
        <li style={s.li}>Ensuring that data you upload or store complies with applicable laws and that you have the legal right to share that data</li>
        <li style={s.li}>Maintaining your own backups of important data</li>
        <li style={s.li}>Carefully evaluating what information you share with AI features, AI assistants, AI agents, and any third-party AI tools accessed through the Platform (including via API or MCP integrations)</li>
        <li style={s.li}>Understanding that data shared with AI providers (Google, OpenAI, Anthropic, etc.) is subject to those providers{"'"} terms and may be processed outside the Company{"'"}s control</li>
        <li style={s.li}>Obtaining all necessary consents from third parties (your contacts, customers, employees, etc.) before storing their information on the Platform or sharing it with AI features</li>
        <li style={s.li}>Complying with privacy laws applicable to data you collect, including GDPR, CCPA, CPRA, HIPAA, and other regulations</li>
      </ul>
      <p style={s.p}>For additional details on your responsibilities — particularly regarding AI features, AI agents, and third-party integrations — please review the corresponding sections of our <a href="/terms" style={s.link}>Terms &amp; Conditions</a>.</p>

      <h2 style={s.h2}>8. Anonymized and Aggregated Data</h2>
      <p style={s.p}>The Company may collect, use, and share anonymized and aggregated data derived from your use of the Platform for any business purpose, including but not limited to: improving the Platform, analyzing usage patterns, developing new features, training internal models, marketing, research, benchmarking, and publishing industry insights or statistics.</p>
      <p style={s.p}>Anonymized data is data from which all personally identifiable information has been removed and that cannot reasonably be linked back to any individual or organization. Aggregated data combines information from many users so that no individual user can be identified.</p>
      <p style={s.p}>The Company will not share, publish, or sell raw personal data, identifiable contact information, or your business{"'"} confidential information without your explicit consent.</p>

      <h2 style={s.h2}>9. Your Rights and Choices</h2>

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

      <h2 style={s.h2}>10. Data Retention</h2>
      <p style={s.p}>We retain your data for as long as your account is active or as needed to provide services. If you delete your account, we will delete or anonymize your data within 30 days, except where we are legally required to retain it (e.g., financial records, tax documentation). Backup copies may persist for up to 90 days before being fully purged.</p>

      <h2 style={s.h2}>11. Cookies</h2>
      <p style={s.p}>We use only essential cookies required for authentication and session management. We do not use third-party tracking cookies, analytics cookies, or advertising cookies on the Platform.</p>

      <h2 style={s.h2}>12. Children{"'"}s Privacy</h2>
      <p style={s.p}>LaunchOS is not directed to children under 13 (or under 16 in the EEA). We do not knowingly collect personal information from children. If we become aware that we have collected data from a child, we will delete it promptly.</p>

      <h2 style={s.h2}>13. International Data Transfers</h2>
      <p style={s.p}>Your data is stored on servers in Germany (EU). If you access the Platform from outside the EU, your data will be transferred to and processed in the EU. We rely on Hetzner{"'"}s GDPR-compliant infrastructure for data hosting.</p>

      <h2 style={s.h2}>14. Changes to This Policy</h2>
      <p style={s.p}>We may update this Privacy Policy from time to time. We will notify you of material changes via email or in-app notification at least 14 days before the changes take effect. The "Last updated" date at the top reflects the most recent revision.</p>

      <h2 style={s.h2}>15. Contact Us</h2>
      <p style={s.p}>If you have questions about this policy or our practices, contact us at <a href="mailto:privacy@thelaunchpadincubator.com" style={s.link}>privacy@thelaunchpadincubator.com</a>.</p>

      <div style={s.footer}>
        <p><a href="/terms" style={s.link}>Terms &amp; Conditions</a> · <a href="/login" style={s.link}>Back to LaunchOS</a></p>
        <p style={{ marginTop: 8, color: '#bbb' }}>© {new Date().getFullYear()} The Launch Pad LLC. All rights reserved.</p>
      </div>
    </div>
  )
}
