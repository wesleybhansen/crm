export const metadata = { title: 'Terms &amp; Conditions — LaunchOS CRM' }

export default function TermsPage() {
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
      <h1 style={s.h1}>LaunchOS CRM — Terms &amp; Conditions</h1>
      <p style={s.updated}>Last updated: April 6, 2026</p>

      <div style={s.callout}>
        <strong>Incorporation of Company-Wide Terms:</strong> <a href="https://thelaunchpadincubator.com/terms/" style={s.link}>The Launch Pad LLC Terms &amp; Conditions</a> are expressly incorporated into and made a part of these Terms by reference. All terms and provisions of the company-wide terms apply to your use of the LaunchOS CRM platform, except where they directly conflict with the terms set forth in this document, in which case the terms of this document shall control with respect to the Platform.
      </div>

      <p style={s.p}>These Terms of Service ("Terms") constitute a legally binding agreement between you ("User," "you," "your") and The Launch Pad LLC ("Company," "we," "our," "us"), governing your access to and use of the LaunchOS CRM platform at crm.thelaunchpadincubator.com (the "Platform"). By creating an account, accessing, or using the Platform, you acknowledge that you have read, understood, and agree to be bound by these Terms and our <a href="/privacy" style={s.link}>Privacy Policy</a>.</p>

      <h2 style={s.h2}>1. Eligibility</h2>
      <p style={s.p}>You must be at least 18 years old and have the legal capacity to enter into a binding agreement to use the Platform. If you are using the Platform on behalf of an organization, you represent that you have the authority to bind that organization to these Terms.</p>

      <h2 style={s.h2}>2. Account Registration and Security</h2>
      <p style={s.p}>You must provide accurate, complete, and current information when creating an account. You are solely responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account. You must notify us immediately if you suspect unauthorized access to your account. We reserve the right to suspend or terminate accounts that contain false or misleading information.</p>

      <h2 style={s.h2}>3. Your Data and Ownership</h2>
      <p style={s.p}>You retain all ownership rights to the data you create, upload, or store in the Platform, including but not limited to contacts, deals, emails, notes, invoices, landing pages, courses, and all other CRM content ("User Data"). We do not claim any ownership interest in your User Data.</p>
      <p style={s.p}>You grant us a limited, non-exclusive, worldwide license to store, process, display, and transmit your User Data solely to operate and provide the Platform{"'"}s features. This license terminates when you delete your account or remove the applicable data.</p>
      <p style={s.p}>You may export your data at any time via the Platform{"'"}s CSV export features. Upon account deletion, we will delete your User Data within 30 days, except where retention is required by law.</p>

      <h2 style={s.h2}>4. Acceptable Use</h2>
      <p style={s.p}>You agree to use the Platform only for lawful business purposes. You shall not:</p>
      <ul style={s.ul}>
        <li style={s.li}>Send spam, unsolicited bulk emails, or messages in violation of CAN-SPAM, GDPR, CASL, or other applicable anti-spam laws</li>
        <li style={s.li}>Upload, transmit, or store malicious code, viruses, or any content intended to damage or compromise system security</li>
        <li style={s.li}>Attempt to gain unauthorized access to other users{"'"} accounts, data, or any part of the Platform{"'"}s infrastructure</li>
        <li style={s.li}>Use the Platform to harass, threaten, defame, or abuse any person</li>
        <li style={s.li}>Resell, sublicense, or redistribute access to the Platform without prior written authorization</li>
        <li style={s.li}>Use the Platform to collect or store personal information about individuals without their consent</li>
        <li style={s.li}>Use automated bots, scrapers, or other automated means to access the Platform beyond the provided API</li>
        <li style={s.li}>Interfere with or disrupt the integrity or performance of the Platform</li>
        <li style={s.li}>Use the Platform in any manner that violates applicable local, state, national, or international law</li>
      </ul>
      <p style={s.p}>Violation of this section may result in immediate suspension or termination of your account without notice or refund.</p>

      <h2 style={s.h2}>5. Connected Third-Party Services</h2>
      <p style={s.p}>The Platform integrates with third-party services including Google (Gmail, Calendar), Microsoft (Outlook), and Stripe. Your use of these integrations is subject to the respective service{"'"}s terms of service and privacy policies in addition to these Terms. We are not responsible for the availability, accuracy, or performance of third-party services.</p>
      <p style={s.p}>You may disconnect any third-party service at any time through Settings. Disconnecting a service immediately revokes our access and deletes stored authentication tokens for that service.</p>

      <h2 style={s.h2}>6. AI-Powered Features — User Responsibility</h2>

      <p style={s.p}>The Platform includes AI-powered features that use third-party AI services (including but not limited to Google Gemini, OpenAI, and others). These features include email drafting, content generation, landing page copy creation, course content generation, brand voice analysis, voice assistants, automated workflows, and AI agents that can take actions on the Platform on your behalf.</p>

      <div style={s.callout}>
        <strong>READ THIS SECTION CAREFULLY.</strong> By using any AI feature on the Platform, you acknowledge and agree to the terms in this Section 6. AI is not infallible. AI will make mistakes. You — not the Company — are solely responsible for everything that happens as a result of using AI features.
      </div>

      <h3 style={s.h3}>6.1 AI Is Not Reliable or Infallible</h3>
      <p style={s.p}>You acknowledge and agree that:</p>
      <ul style={s.ul}>
        <li style={s.li}><strong>AI WILL make mistakes.</strong> It is not a question of "if" — AI models hallucinate, fabricate facts, generate inaccurate information, misinterpret instructions, produce biased or inappropriate content, take incorrect actions, send wrong data to wrong recipients, and otherwise fail in unpredictable ways.</li>
        <li style={s.li}><strong>AI output is NOT a source of truth.</strong> Any information, summary, draft, recommendation, or action generated by AI may be incomplete, outdated, misleading, factually wrong, or harmful. You must independently verify all AI-generated content before relying on it for any business decision, communication, transaction, or other action.</li>
        <li style={s.li}><strong>AI cannot guarantee outcomes.</strong> The Company makes no representations or warranties about the quality, accuracy, reliability, completeness, or fitness for any purpose of any AI-generated output.</li>
      </ul>

      <h3 style={s.h3}>6.2 You Are Solely Responsible for AI-Generated Content</h3>
      <p style={s.p}>You are solely responsible for:</p>
      <ul style={s.ul}>
        <li style={s.li}><strong>Reviewing every AI output before use.</strong> Before sending any AI-drafted email, publishing any AI-generated content, executing any AI-suggested action, or otherwise relying on AI output, you must carefully review, edit, fact-check, and approve it.</li>
        <li style={s.li}><strong>Verifying accuracy.</strong> You must independently verify the factual accuracy of any AI-generated information, including names, contact details, dates, prices, statistics, claims, legal information, financial figures, and any other facts.</li>
        <li style={s.li}><strong>Ensuring compliance.</strong> You must ensure that any AI-generated content complies with all applicable laws and regulations, including but not limited to advertising laws, consumer protection laws, anti-spam laws (CAN-SPAM, CASL, GDPR, etc.), securities laws, healthcare laws (HIPAA), financial regulations, and intellectual property laws.</li>
        <li style={s.li}><strong>Appropriateness.</strong> You must ensure AI-generated content is appropriate for its intended audience and does not contain offensive, defamatory, discriminatory, harmful, or otherwise objectionable material.</li>
        <li style={s.li}><strong>Tone and brand alignment.</strong> You are responsible for ensuring AI-generated content represents your brand and intentions accurately.</li>
      </ul>

      <h3 style={s.h3}>6.3 You Are Solely Responsible for AI Actions on Your Behalf</h3>
      <p style={s.p}>The Platform includes AI agents and automated features that can take actions on your behalf, including but not limited to: sending emails, creating contacts, modifying records, scheduling meetings, processing payments, publishing landing pages, creating tasks, executing workflows, and triggering automations.</p>
      <p style={s.p}>You acknowledge and agree that:</p>
      <ul style={s.ul}>
        <li style={s.li}><strong>You authorize all AI actions.</strong> When you enable, configure, or invoke any AI feature, you authorize the AI to take actions on your behalf within the scope of that feature. You are legally responsible for every action taken by AI on your behalf, just as if you had taken the action yourself.</li>
        <li style={s.li}><strong>AI may take wrong actions.</strong> AI may misinterpret your instructions, send emails to the wrong recipients, modify the wrong records, execute the wrong workflows, or take other incorrect actions. You are responsible for monitoring, reviewing, and correcting any AI actions.</li>
        <li style={s.li}><strong>You must configure safeguards.</strong> You are responsible for configuring confirmation steps, approval workflows, scope limitations, and other safeguards to prevent AI from taking unintended or harmful actions. The Company is not responsible if you fail to configure adequate safeguards.</li>
        <li style={s.li}><strong>Third-party AI agents.</strong> If you use third-party AI agents, automation tools, or scripts to interact with the Platform via API or other means, you are solely responsible for the actions of those agents. The Company has no control over and assumes no responsibility for third-party AI behavior.</li>
      </ul>

      <h3 style={s.h3}>6.4 You Are Solely Responsible for Your Information and Data Safety</h3>
      <p style={s.p}>You acknowledge and agree that:</p>
      <ul style={s.ul}>
        <li style={s.li}><strong>You control what data AI processes.</strong> When you use AI features, you choose what information to provide to the AI. You are responsible for ensuring you do not share confidential, sensitive, regulated, or personal information that you do not have the right to share or that should not be processed by AI.</li>
        <li style={s.li}><strong>AI providers may process your data.</strong> AI features send your data to third-party AI providers (Google, OpenAI, etc.) for processing. You consent to this data transfer when you use AI features. You are responsible for understanding and complying with the privacy policies and terms of service of these AI providers.</li>
        <li style={s.li}><strong>Sensitive data warning.</strong> Do not use AI features to process protected health information (PHI), payment card data (PCI), social security numbers, government IDs, attorney-client privileged information, or other sensitive data unless you have verified that the relevant AI provider is appropriately certified and you have obtained all necessary consents.</li>
        <li style={s.li}><strong>Data protection.</strong> You are responsible for protecting your account credentials, API keys, OAuth tokens, and any other security credentials. The Company is not responsible for unauthorized use of AI features resulting from compromised credentials.</li>
      </ul>

      <h3 style={s.h3}>6.5 No Professional Advice</h3>
      <p style={s.p}>AI-generated content provided through the Platform is NOT a substitute for professional advice. AI cannot and does not provide legal, financial, medical, tax, accounting, mental health, or any other form of professional advice. If you need professional advice, consult a qualified human professional. The Company expressly disclaims any responsibility for AI-generated content that may be construed as professional advice.</p>

      <h3 style={s.h3}>6.6 No Liability for AI Output or Actions</h3>
      <p style={s.p}><strong>To the maximum extent permitted by law, the Company shall not be liable for any direct, indirect, incidental, consequential, special, exemplary, or punitive damages arising out of or in connection with: (a) any AI-generated content or output; (b) any action taken by AI on your behalf or on behalf of third parties; (c) any decision you make based on AI output; (d) any harm caused by AI errors, hallucinations, biases, or failures; (e) any data sent to or processed by third-party AI providers; (f) any unauthorized access to or use of AI features; or (g) any violation of law, regulation, or third-party right resulting from AI-generated content or actions.</strong></p>

      <h3 style={s.h3}>6.7 Indemnification for AI Use</h3>
      <p style={s.p}>You agree to indemnify, defend, and hold harmless the Company and its officers, directors, employees, agents, affiliates, and AI service providers from and against any and all claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys{"'"} fees) arising out of or related to: (a) any AI-generated content you sent, published, or distributed; (b) any action taken by AI on your behalf; (c) any decision you made based on AI output; (d) any data you provided to AI features; or (e) any violation of these Terms or applicable law arising from your use of AI features.</p>

      <h3 style={s.h3}>6.8 AI Features May Change</h3>
      <p style={s.p}>AI features may be added, modified, improved, degraded, or discontinued at any time, with or without notice, as we update the Platform or as third-party AI providers change their services. The Company is not responsible for any disruption, change, or removal of AI features.</p>

      <p style={s.p}><strong>BY USING ANY AI FEATURE OF THE PLATFORM, YOU EXPRESSLY ACKNOWLEDGE THAT YOU HAVE READ, UNDERSTOOD, AND AGREE TO BE BOUND BY THIS SECTION 6 IN ITS ENTIRETY.</strong></p>

      <h2 style={s.h2}>7. Payments and Billing</h2>
      <p style={s.p}>Payments processed through the Platform (invoices, product sales, funnel checkouts) use Stripe as the payment processor. By using payment features, you agree to <a href="https://stripe.com/legal" style={s.link}>Stripe{"'"}s Terms of Service</a>.</p>
      <p style={s.p}>Payment disputes between you and your customers should be resolved through Stripe{"'"}s dispute resolution process. The Company facilitates payment processing but is not a party to transactions between you and your customers.</p>
      <p style={s.p}>The Company reserves the right to introduce subscription fees for Platform access in the future. Any pricing changes will be communicated at least 30 days in advance, and you will have the option to cancel before new charges apply.</p>

      <h2 style={s.h2}>8. Intellectual Property</h2>
      <p style={s.p}>The Platform, including its design, code, features, documentation, logos, and branding, is the intellectual property of the Company and is protected by copyright, trademark, and other intellectual property laws. You are granted a limited, non-exclusive, non-transferable, revocable license to use the Platform for your business purposes in accordance with these Terms.</p>
      <p style={s.p}>You shall not: copy, modify, distribute, sell, or create derivative works based on the Platform; reverse engineer, decompile, or disassemble any part of the Platform; remove or alter any proprietary notices or labels; or use the Platform{"'"}s proprietary materials to create a competing product or service.</p>

      <h2 style={s.h2}>9. Service Availability</h2>
      <p style={s.p}>We strive to maintain the Platform{"'"}s availability 24/7, but we do not guarantee uninterrupted, error-free, or secure service. The Platform may be temporarily unavailable due to maintenance, updates, server failures, or circumstances beyond our control. We will make reasonable efforts to provide advance notice of planned maintenance when possible.</p>

      <h2 style={s.h2}>10. Disclaimer of Warranties</h2>
      <p style={s.p}><strong>THE PLATFORM IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY.</strong> To the fullest extent permitted by law, we disclaim all warranties, including but not limited to implied warranties of merchantability, fitness for a particular purpose, non-infringement, and any warranties arising from course of dealing or usage of trade.</p>
      <p style={s.p}>We do not warrant that: the Platform will meet your specific requirements; the Platform will be uninterrupted, timely, secure, or error-free; the results obtained from using the Platform will be accurate or reliable; or any errors will be corrected.</p>

      <h2 style={s.h2}>11. Limitation of Liability</h2>
      <p style={s.p}><strong>TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE COMPANY, ITS OFFICERS, DIRECTORS, EMPLOYEES, AGENTS, AND AFFILIATES SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES</strong>, including but not limited to loss of profits, data, business opportunities, goodwill, or other intangible losses, arising out of or in connection with your use of or inability to use the Platform, even if we have been advised of the possibility of such damages.</p>
      <p style={s.p}>Our total aggregate liability for any and all claims arising from or related to these Terms or the Platform shall not exceed the greater of: (a) the total fees you have paid to us in the six (6) months preceding the claim; or (b) one hundred dollars ($100.00 USD).</p>

      <h2 style={s.h2}>12. Indemnification</h2>
      <p style={s.p}>You agree to indemnify, defend, and hold harmless the Company and its officers, directors, employees, agents, and affiliates from and against any and all claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys{"'"} fees) arising out of or related to: (a) your use of the Platform; (b) your violation of these Terms; (c) your violation of any applicable law or third-party right; (d) any content you create, upload, or distribute through the Platform; or (e) any dispute between you and your customers or contacts.</p>

      <h2 style={s.h2}>13. Dispute Resolution and Arbitration</h2>
      <p style={s.p}><strong>Binding Arbitration:</strong> Any dispute, controversy, or claim arising out of or relating to these Terms or the Platform shall be resolved by binding arbitration administered in accordance with the rules of the American Arbitration Association. The arbitration shall be conducted in the State of Wyoming, and the arbitrator{"'"}s decision shall be final and binding.</p>
      <p style={s.p}><strong>Class Action Waiver:</strong> You agree that any dispute resolution proceedings will be conducted only on an individual basis and not in a class, consolidated, or representative action. You waive any right to participate in a class action lawsuit or class-wide arbitration.</p>
      <p style={s.p}><strong>Jury Trial Waiver:</strong> To the fullest extent permitted by law, you waive any right to a jury trial in any dispute arising from these Terms.</p>
      <p style={s.p}><strong>Exception:</strong> Either party may seek injunctive or other equitable relief in any court of competent jurisdiction to prevent the actual or threatened infringement of intellectual property rights.</p>

      <h2 style={s.h2}>14. Termination</h2>
      <p style={s.p}>You may terminate your account at any time by contacting us. We may suspend or terminate your account at any time, with or without cause, with or without notice. Upon termination: your right to access the Platform ceases immediately; we will delete your User Data within 30 days (except where legally required to retain); and any provisions that by their nature should survive termination will survive (including Sections 8, 10-13, and 15).</p>

      <h2 style={s.h2}>15. Governing Law</h2>
      <p style={s.p}>These Terms shall be governed by and construed in accordance with the laws of the State of Wyoming, United States, without regard to its conflict of law provisions.</p>

      <h2 style={s.h2}>16. Assumption of Risk</h2>
      <p style={s.p}>The Platform is a business tool. The Company does not guarantee any specific business outcomes, revenue, leads, conversions, or results from using the Platform. Your business success depends on many factors beyond our control. You assume all risk associated with your business decisions and use of the Platform.</p>

      <h2 style={s.h2}>17. Modifications to Terms</h2>
      <p style={s.p}>We reserve the right to modify these Terms at any time. Material changes will be communicated via email or in-app notification at least 14 days before taking effect. Continued use of the Platform after changes take effect constitutes acceptance of the updated Terms. If you disagree with any changes, you must stop using the Platform and delete your account.</p>

      <h2 style={s.h2}>18. Miscellaneous</h2>
      <ul style={s.ul}>
        <li style={s.li}><strong>Entire Agreement:</strong> These Terms, together with the Privacy Policy, constitute the entire agreement between you and the Company regarding the Platform.</li>
        <li style={s.li}><strong>Severability:</strong> If any provision is found unenforceable, the remaining provisions remain in full force and effect.</li>
        <li style={s.li}><strong>Waiver:</strong> Failure to enforce any provision does not constitute a waiver of that provision.</li>
        <li style={s.li}><strong>Assignment:</strong> You may not assign these Terms without our written consent. We may assign these Terms in connection with a merger, acquisition, or sale of assets.</li>
        <li style={s.li}><strong>No Third-Party Beneficiaries:</strong> These Terms do not confer any rights on third parties.</li>
        <li style={s.li}><strong>Electronic Communications:</strong> By using the Platform, you consent to receiving electronic communications from us and agree that such communications satisfy any legal requirement for written communication.</li>
      </ul>

      <h2 style={s.h2}>Contact Information</h2>
      <p style={s.p}>The Services are offered by The Launch Pad LLC. You may contact us by email at: <a href="mailto:hello@thelaunchpadincubator.com" style={s.link}>hello@thelaunchpadincubator.com</a>.</p>

      <div style={s.footer}>
        <p><a href="/privacy" style={s.link}>Privacy Policy</a> · <a href="/login" style={s.link}>Back to LaunchOS</a></p>
        <p style={{ marginTop: 8, color: '#bbb' }}>© {new Date().getFullYear()} The Launch Pad LLC. All rights reserved.</p>
      </div>
    </div>
  )
}
