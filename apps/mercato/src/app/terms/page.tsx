export const metadata = { title: 'Terms of Service — LaunchOS' }

export default function TermsPage() {
  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '40px 24px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: '#333', lineHeight: 1.7 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Terms of Service</h1>
      <p style={{ color: '#666', marginBottom: 32 }}>Last updated: April 5, 2026</p>

      <p>These Terms of Service ("Terms") govern your use of LaunchOS, a CRM platform operated by The Launchpad Incubator ("we", "our", "us"). By creating an account or using the platform, you agree to these Terms.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>1. Account</h2>
      <p>You must provide accurate information when creating an account. You are responsible for maintaining the security of your account credentials. You must be at least 18 years old to use LaunchOS.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>2. Acceptable Use</h2>
      <p>You agree to use LaunchOS only for lawful business purposes. You will not:</p>
      <ul>
        <li>Send spam or unsolicited bulk emails through the platform</li>
        <li>Upload malicious content or attempt to compromise system security</li>
        <li>Use the platform to harass, abuse, or harm others</li>
        <li>Resell access to the platform without authorization</li>
        <li>Violate any applicable laws, including CAN-SPAM, GDPR, or CCPA</li>
      </ul>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>3. Your Data</h2>
      <p>You own all data you create in LaunchOS (contacts, deals, emails, etc.). We do not claim ownership of your content. You grant us a license to store, process, and display your data solely to operate the platform and provide its features.</p>
      <p>You can export your data at any time via CSV export. If you cancel your account, we will delete your data within 30 days unless required by law to retain it.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>4. Connected Services</h2>
      <p>LaunchOS integrates with third-party services (Gmail, Google Calendar, Stripe, etc.). Your use of these integrations is also subject to the respective service's terms. We are not responsible for the availability or actions of third-party services.</p>
      <p>You can disconnect any third-party service at any time through Settings.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>5. AI Features</h2>
      <p>LaunchOS includes AI-powered features (email drafting, content generation, voice analysis). AI-generated content is provided as suggestions — you are responsible for reviewing and approving any content before it is sent or published. We are not liable for AI-generated content that is inaccurate, inappropriate, or causes harm.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>6. Payments</h2>
      <p>Payments are processed through Stripe. By using payment features, you agree to Stripe's terms of service. We are not responsible for payment disputes between you and your customers — these should be resolved directly through Stripe.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>7. Service Availability</h2>
      <p>We strive to keep LaunchOS available 24/7, but we do not guarantee uninterrupted service. We may perform maintenance, updates, or experience outages. We will notify you of planned maintenance when possible.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>8. Limitation of Liability</h2>
      <p>LaunchOS is provided "as is" without warranties of any kind. To the maximum extent permitted by law, we are not liable for any indirect, incidental, special, or consequential damages arising from your use of the platform, including but not limited to lost profits, data loss, or business interruption.</p>
      <p>Our total liability for any claim arising from these Terms shall not exceed the amount you paid us in the 12 months preceding the claim.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>9. Termination</h2>
      <p>You can cancel your account at any time. We may suspend or terminate your account if you violate these Terms. Upon termination, your right to use the platform ceases immediately.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>10. Changes to Terms</h2>
      <p>We may update these Terms from time to time. We will notify you of material changes via email or in-app notification. Continued use of the platform after changes constitutes acceptance of the updated Terms.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>11. Governing Law</h2>
      <p>These Terms are governed by the laws of the State of California, United States, without regard to conflict of law provisions.</p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>12. Contact</h2>
      <p>For questions about these Terms, contact:</p>
      <p>Wesley Hansen<br />Email: wesley.b.hansen@gmail.com<br />LaunchOS — The Launchpad Incubator</p>

      <div style={{ marginTop: 48, paddingTop: 24, borderTop: '1px solid #eee', color: '#999', fontSize: 13 }}>
        <a href="/login" style={{ color: '#0000CC' }}>Back to LaunchOS</a>
      </div>
    </div>
  )
}
