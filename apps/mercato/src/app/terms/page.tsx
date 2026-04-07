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

      <h2 style={s.h2}>4. Acceptable Use Policy</h2>
      <p style={s.p}>You agree to use the Platform only for lawful business purposes. The following is a non-exhaustive list of activities that are strictly prohibited. You shall not, and shall not permit any third party to:</p>

      <h3 style={s.h3}>4.1 Communications and Anti-Spam Compliance</h3>
      <p style={s.p}>You are solely responsible for ensuring that all communications you send through the Platform — including emails, SMS messages, automated sequences, marketing campaigns, and AI-generated communications — comply with applicable laws including but not limited to CAN-SPAM (US), CASL (Canada), GDPR (EU/EEA), PECR (UK), the TCPA (US, for SMS/calls), and any other applicable anti-spam, telemarketing, or electronic communication laws. You shall not:</p>
      <ul style={s.ul}>
        <li style={s.li}>Send spam, unsolicited bulk emails, or commercial messages without proper consent or legal basis</li>
        <li style={s.li}>Send messages with false, misleading, or deceptive headers, subject lines, or sender information</li>
        <li style={s.li}>Fail to honor unsubscribe requests or opt-outs within legally required timeframes</li>
        <li style={s.li}>Send commercial messages to recipients who have withdrawn consent</li>
        <li style={s.li}>Send messages to purchased, scraped, rented, or harvested email lists</li>
        <li style={s.li}>Conceal or misrepresent your identity as the sender</li>
      </ul>
      <p style={s.p}>You are the "sender" of all communications you transmit through the Platform under applicable law. The Company is not the sender, controller, or originator of your communications and bears no responsibility for compliance.</p>

      <h3 style={s.h3}>4.2 Prohibited Content</h3>
      <p style={s.p}>You shall not upload, store, transmit, generate, or distribute through the Platform any content that:</p>
      <ul style={s.ul}>
        <li style={s.li}>Is illegal, defamatory, libelous, obscene, pornographic, or exploitative</li>
        <li style={s.li}>Infringes any patent, trademark, copyright, trade secret, publicity, privacy, or other intellectual property right</li>
        <li style={s.li}>Constitutes hate speech, incites violence, or promotes discrimination based on race, ethnicity, national origin, religion, gender, sexual orientation, disability, or other protected characteristic</li>
        <li style={s.li}>Promotes terrorism, violent extremism, or material support for prohibited organizations</li>
        <li style={s.li}>Promotes illegal goods or services, including illegal drugs, weapons, counterfeit goods, or human trafficking</li>
        <li style={s.li}>Constitutes child sexual abuse material (CSAM) or content that exploits minors in any way</li>
        <li style={s.li}>Promotes pyramid schemes, multi-level marketing fraud, get-rich-quick schemes, or other deceptive business practices</li>
        <li style={s.li}>Promotes gambling in jurisdictions where gambling is illegal</li>
        <li style={s.li}>Contains medical, legal, financial, or other professional advice unless you are licensed to provide such advice</li>
        <li style={s.li}>Is intended to deceive, defraud, or manipulate recipients (including phishing, scams, fake reviews, or election interference)</li>
        <li style={s.li}>Contains malware, viruses, ransomware, spyware, worms, trojans, or any other malicious code</li>
      </ul>

      <h3 style={s.h3}>4.3 Prohibited Conduct</h3>
      <p style={s.p}>You shall not:</p>
      <ul style={s.ul}>
        <li style={s.li}>Attempt to gain unauthorized access to other users{"'"} accounts, data, the Platform{"'"}s infrastructure, source code, databases, or any non-public area of the Platform</li>
        <li style={s.li}>Probe, scan, or test the vulnerability of the Platform without prior written authorization from the Company</li>
        <li style={s.li}>Use the Platform to harass, stalk, threaten, dox, defame, abuse, intimidate, or impersonate any person</li>
        <li style={s.li}>Resell, sublicense, lease, rent, or redistribute access to the Platform without prior written authorization from the Company</li>
        <li style={s.li}>Use the Platform to collect, store, or process personal information about individuals without their consent and lawful basis</li>
        <li style={s.li}>Use automated bots, scrapers, crawlers, or other automated means to access the Platform beyond the provided official API and within published rate limits</li>
        <li style={s.li}>Interfere with, disrupt, overload, flood, or impair the integrity or performance of the Platform or its infrastructure</li>
        <li style={s.li}>Use the Platform to mine cryptocurrency, run distributed computing tasks unrelated to CRM use, or otherwise consume excessive system resources</li>
        <li style={s.li}>Circumvent any access controls, rate limits, usage limits, security features, or technical restrictions of the Platform</li>
        <li style={s.li}>Use the Platform in any manner that violates applicable local, state, national, or international law</li>
      </ul>

      <h3 style={s.h3}>4.4 Anti-Circumvention, Reverse Engineering, and Benchmarking</h3>
      <p style={s.p}>You shall not, and shall not permit any third party to:</p>
      <ul style={s.ul}>
        <li style={s.li}>Reverse engineer, decompile, disassemble, or otherwise attempt to derive the source code, algorithms, models, prompts, system architecture, data structures, or trade secrets of the Platform</li>
        <li style={s.li}>Use the Platform, its data, or its outputs to train, fine-tune, evaluate, or benchmark any artificial intelligence model, machine learning system, or competing product</li>
        <li style={s.li}>Copy, duplicate, mirror, or replicate any portion of the Platform{"'"}s features, design, prompts, or workflows for the purpose of building or improving a competing product</li>
        <li style={s.li}>Conduct or publish performance benchmarks, comparison studies, security assessments, or competitive analyses of the Platform without prior written authorization from the Company</li>
        <li style={s.li}>Remove, alter, obscure, or tamper with any proprietary notices, copyright marks, trademarks, watermarks, or attribution on the Platform</li>
        <li style={s.li}>Use the Platform to develop a substantially similar product or service that competes with the Platform</li>
      </ul>

      <h3 style={s.h3}>4.5 Enforcement</h3>
      <p style={s.p}>The Company reserves the right, in its sole discretion, to investigate, suspend, or terminate any account that violates this Acceptable Use Policy. Violations may result in immediate suspension or termination of your account without prior notice and without refund. The Company may also report violations to law enforcement, regulators, or other appropriate authorities, and may cooperate with investigations or legal proceedings related to such violations. The Company is not obligated to monitor user conduct but reserves the right to do so.</p>

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

      <h2 style={s.h2}>7. User Responsibility for Data Protection and Information Security</h2>
      <p style={s.p}>You are solely responsible for protecting and securing your data, your account, and any information you upload, store, transmit, or share through the Platform. This responsibility is non-delegable and applies regardless of which Platform features you use.</p>

      <h3 style={s.h3}>7.1 Account Security</h3>
      <p style={s.p}>You are solely responsible for:</p>
      <ul style={s.ul}>
        <li style={s.li}>Maintaining the confidentiality and security of your username, password, API keys, OAuth tokens, session cookies, and any other authentication credentials</li>
        <li style={s.li}>All activity that occurs under your account, whether or not authorized by you</li>
        <li style={s.li}>Implementing strong passwords, enabling multi-factor authentication where available, and following security best practices</li>
        <li style={s.li}>Promptly notifying the Company of any actual or suspected unauthorized access, security breach, or compromise of your account</li>
        <li style={s.li}>Logging out of shared or public devices and maintaining physical security of devices used to access the Platform</li>
      </ul>
      <p style={s.p}>The Company is not liable for any loss, damage, or harm resulting from your failure to protect your credentials or account.</p>

      <h3 style={s.h3}>7.2 Data You Upload, Store, and Share</h3>
      <p style={s.p}>You are solely responsible for:</p>
      <ul style={s.ul}>
        <li style={s.li}>Determining what data you upload, store, transmit, or share through the Platform</li>
        <li style={s.li}>Ensuring you have the legal right and necessary consents to upload, process, and store all User Data, including data about third parties (contacts, customers, prospects, employees, etc.)</li>
        <li style={s.li}>Complying with all applicable laws regarding data collection, processing, and storage, including but not limited to GDPR, CCPA, CPRA, HIPAA, GLBA, FERPA, COPPA, CAN-SPAM, CASL, and any other privacy or data protection laws</li>
        <li style={s.li}>Maintaining your own backups of critical data — you should not rely solely on the Platform as your only copy of important information</li>
        <li style={s.li}>Properly classifying, handling, and protecting any sensitive, confidential, regulated, or proprietary information you store on the Platform</li>
      </ul>

      <h3 style={s.h3}>7.3 Sharing Data with AI and AI Agents — Critical Responsibility</h3>
      <p style={s.p}><strong>You are solely responsible for any information you choose to share with AI features, AI assistants, AI agents, or third-party AI tools — whether built into the Platform or accessed through it (including via API, MCP, or other integrations).</strong></p>
      <p style={s.p}>When you use AI features or allow AI agents to access your data, you acknowledge and agree:</p>
      <ul style={s.ul}>
        <li style={s.li}><strong>You control what data the AI sees.</strong> Before invoking any AI feature or allowing an AI agent to access your data, you must consciously evaluate whether the data is appropriate to share with that AI system. Once data is sent to an AI provider, it may be processed, stored, logged, or used by that provider in ways outside the Company{"'"}s control.</li>
        <li style={s.li}><strong>Sensitive data requires special care.</strong> You must not share with AI features any data that you are not legally permitted to share with third-party AI providers, including: protected health information (PHI), payment card data (PCI), Social Security numbers, government-issued identification numbers, attorney-client privileged information, trade secrets you do not own, biometric data, information about minors, or any data subject to confidentiality agreements that prohibit sharing with third parties.</li>
        <li style={s.li}><strong>Third-party AI provider terms apply.</strong> AI features route data through third-party providers (including but not limited to Google, OpenAI, Anthropic, and others). You are responsible for understanding and complying with each AI provider{"'"}s terms of service, privacy policy, and data handling practices. The Company makes no representations about how third-party AI providers handle your data.</li>
        <li style={s.li}><strong>External AI agents and MCP connections.</strong> If you connect external AI agents, third-party AI assistants, MCP clients, automation tools, or any non-LaunchOS AI system to the Platform via API or other means, you are solely responsible for: (a) what data those external systems can access; (b) how those external systems process, store, transmit, or share your data; (c) the security practices of those external systems; (d) any data leakage, breach, or unauthorized disclosure resulting from those connections; and (e) the actions those external AI systems take on your behalf within the Platform.</li>
        <li style={s.li}><strong>Third-party data and consent.</strong> If you share data about third parties (such as contacts, customers, or employees) with AI features, you represent and warrant that you have all necessary rights, consents, and legal authority to do so. You are solely responsible for any claims arising from sharing third-party data with AI systems.</li>
        <li style={s.li}><strong>You assume the risk.</strong> AI systems can be compromised, exfiltrate data, leak information across sessions, expose data through prompt injection attacks, or behave unexpectedly. You assume all risks associated with sharing your data with any AI system. The Company is not liable for any data exposure, breach, leak, or harm resulting from your decision to share data with AI features or AI agents.</li>
      </ul>

      <h3 style={s.h3}>7.4 Data Compliance and Privacy Obligations to Third Parties</h3>
      <p style={s.p}>If you collect, store, or process information about third parties (your customers, leads, contacts, employees, etc.) through the Platform, you act as a data controller (or data processor, where applicable) under applicable privacy laws. You are solely responsible for:</p>
      <ul style={s.ul}>
        <li style={s.li}>Providing your own privacy notices to those third parties</li>
        <li style={s.li}>Obtaining all required consents (including consent to share data with AI systems where applicable)</li>
        <li style={s.li}>Honoring data subject rights (access, deletion, correction, portability, objection)</li>
        <li style={s.li}>Maintaining records of processing activities</li>
        <li style={s.li}>Reporting data breaches to affected individuals and regulators as required by law</li>
        <li style={s.li}>Executing data processing agreements where required</li>
        <li style={s.li}>Ensuring lawful basis for all processing</li>
      </ul>
      <p style={s.p}>The Company provides the Platform as a tool. You are the controller of the data you put into it.</p>

      <h3 style={s.h3}>7.5 No Data Loss Liability</h3>
      <p style={s.p}>While the Company implements reasonable security measures, the Company does not guarantee against data loss, corruption, unauthorized access, or breach. You are responsible for maintaining your own backups and acknowledge that the Company shall not be liable for any loss of data, regardless of cause.</p>

      <h2 style={s.h2}>8. Beta Features and Experimental Functionality</h2>
      <p style={s.p}>The Platform may include features that are labeled as "beta," "preview," "experimental," "early access," or similar designations, or that are otherwise identified as not yet generally available ("Beta Features"). Beta Features include, without limitation, AI-powered features (Scout voice assistant, Brand Voice Engine, AI email drafting, AI content generation, AI agents, MCP integration), automated workflows, and any new functionality being tested.</p>
      <p style={s.p}>You acknowledge and agree that:</p>
      <ul style={s.ul}>
        <li style={s.li}><strong>Beta Features are provided "AS IS" and "AS AVAILABLE"</strong> with no warranties of any kind, express or implied. Beta Features may contain bugs, errors, defects, security vulnerabilities, or other issues that could cause data loss, incorrect output, or other harm.</li>
        <li style={s.li}><strong>No SLA applies to Beta Features.</strong> Beta Features may be unstable, unreliable, intermittently unavailable, or perform inconsistently. The Company makes no commitments about uptime, response time, performance, or availability of Beta Features.</li>
        <li style={s.li}><strong>Beta Features may change or be removed at any time</strong> without notice, including substantial changes to functionality, pricing, terms, or removal entirely. The Company may end any beta program at its sole discretion.</li>
        <li style={s.li}><strong>You use Beta Features at your own risk.</strong> The Company expressly disclaims all liability for any harm arising from your use of Beta Features, including data loss, incorrect AI output, failed actions, missed communications, business losses, or any other consequences.</li>
        <li style={s.li}><strong>Feedback and telemetry.</strong> By using Beta Features, you grant the Company permission to collect usage data, error logs, performance metrics, and user feedback to improve the features. You also grant the Company a perpetual, royalty-free license to use any feedback you provide for any purpose.</li>
        <li style={s.li}><strong>No reliance on Beta Features.</strong> You should not rely on Beta Features for business-critical operations, mission-critical data, or any use where failure could cause significant harm. You are responsible for maintaining backup processes and not depending solely on Beta Features.</li>
        <li style={s.li}><strong>Confidentiality.</strong> Information about Beta Features, including their existence, functionality, performance, and any feedback you provide, is confidential and may not be disclosed publicly without the Company{"'"}s prior written consent.</li>
      </ul>
      <p style={s.p}>The limitations of liability, disclaimers of warranty, and indemnification provisions in these Terms apply with full force to Beta Features. To the maximum extent permitted by law, the Company{"'"}s total liability for any harm arising from Beta Features is zero.</p>

      <h2 style={s.h2}>9. Payments and Billing</h2>
      <p style={s.p}>Payments processed through the Platform (invoices, product sales, funnel checkouts) use Stripe as the payment processor. By using payment features, you agree to <a href="https://stripe.com/legal" style={s.link}>Stripe{"'"}s Terms of Service</a>.</p>
      <p style={s.p}>Payment disputes between you and your customers should be resolved through Stripe{"'"}s dispute resolution process. The Company facilitates payment processing but is not a party to transactions between you and your customers.</p>
      <p style={s.p}>The Company reserves the right to introduce subscription fees for Platform access in the future. Any pricing changes will be communicated at least 30 days in advance, and you will have the option to cancel before new charges apply.</p>

      <h2 style={s.h2}>10. Intellectual Property</h2>

      <h3 style={s.h3}>10.1 Company Intellectual Property</h3>
      <p style={s.p}>The Platform, including its design, code, features, documentation, logos, branding, system prompts, AI configurations, workflows, templates, and all related materials, is the intellectual property of the Company and is protected by copyright, trademark, trade secret, and other intellectual property laws. You are granted a limited, non-exclusive, non-transferable, revocable license to access and use the Platform for your internal business purposes in accordance with these Terms.</p>
      <p style={s.p}>You shall not: copy, modify, distribute, sell, or create derivative works based on the Platform; reverse engineer, decompile, or disassemble any part of the Platform; remove or alter any proprietary notices or labels; or use the Platform{"'"}s proprietary materials to create a competing product or service. Any rights not expressly granted to you in these Terms are reserved by the Company.</p>

      <h3 style={s.h3}>10.2 Your Content</h3>
      <p style={s.p}>You retain all ownership rights to the User Data and content you create, upload, or store on the Platform. You grant the Company the limited license described in Section 3 to operate the Platform.</p>

      <h3 style={s.h3}>10.3 AI-Generated Output and Intellectual Property Risk</h3>
      <p style={s.p}>You acknowledge and agree that AI-generated output (including but not limited to drafted emails, generated copy, suggestions, summaries, images, voice output, and any other content produced by AI features):</p>
      <ul style={s.ul}>
        <li style={s.li}><strong>Has uncertain ownership and copyright status.</strong> The legal status of AI-generated content is unsettled and varies by jurisdiction. The Company makes no representation that AI output is copyrightable, ownable, or free from third-party intellectual property claims.</li>
        <li style={s.li}><strong>May incorporate or resemble third-party copyrighted material.</strong> AI models are trained on large datasets that may include copyrighted works. AI output may inadvertently reproduce, paraphrase, or resemble copyrighted text, code, images, brands, or other protected material without your knowledge.</li>
        <li style={s.li}><strong>Carries IP infringement risk.</strong> The Company makes no warranty that AI output does not infringe any third party{"'"}s intellectual property rights. You assume all risk that AI-generated content you publish, distribute, or use may infringe third-party rights.</li>
        <li style={s.li}><strong>Is provided without IP indemnity.</strong> The Company does not provide any indemnification, warranty, or defense against intellectual property claims arising from AI output. If a third party claims your use of AI-generated content infringes their rights, you are solely responsible for defending and resolving such claims.</li>
        <li style={s.li}><strong>You are responsible for clearance.</strong> Before using any AI-generated content for commercial purposes, you should review it for potential infringement and consult an attorney if you have concerns.</li>
      </ul>

      <h3 style={s.h3}>10.4 No Implied License to Trademarks or Branding</h3>
      <p style={s.p}>Nothing in these Terms grants you any right to use the Company{"'"}s trademarks, logos, branding, or trade names. You may not display, modify, or use the LaunchOS name, Scout name, or any related branding without prior written permission from the Company.</p>

      <h2 style={s.h2}>11. Service Availability</h2>
      <p style={s.p}>We strive to maintain the Platform{"'"}s availability 24/7, but we do not guarantee uninterrupted, error-free, or secure service. The Platform may be temporarily unavailable due to maintenance, updates, server failures, third-party service outages, or circumstances beyond our control. We will make reasonable efforts to provide advance notice of planned maintenance when possible. The Company offers no service level agreement (SLA) and provides no uptime guarantee unless explicitly stated in a separate written agreement.</p>

      <h2 style={s.h2}>12. Force Majeure</h2>
      <p style={s.p}>The Company shall not be liable for any failure or delay in performance, or for any harm, loss, or damage, arising from circumstances beyond its reasonable control, including but not limited to:</p>
      <ul style={s.ul}>
        <li style={s.li}>Acts of God, natural disasters, fires, floods, earthquakes, storms, or pandemics</li>
        <li style={s.li}>War, terrorism, civil unrest, riots, or government actions</li>
        <li style={s.li}>Strikes, labor disputes, or workforce shortages</li>
        <li style={s.li}>Failures, outages, degradation, or discontinuation of third-party services, including but not limited to: hosting providers (Hetzner, AWS, etc.), AI providers (OpenAI, Google, Anthropic, etc.), email delivery services (Resend, SendGrid, etc.), payment processors (Stripe, etc.), authentication providers (Google OAuth, Microsoft, etc.), domain registrars, CDNs, or any other service the Platform depends on</li>
        <li style={s.li}>Internet outages, DNS failures, BGP routing issues, or network attacks (including DDoS attacks)</li>
        <li style={s.li}>Cybersecurity incidents, data breaches affecting third-party providers, or zero-day vulnerabilities in software or systems the Platform depends on</li>
        <li style={s.li}>Government actions, regulations, sanctions, or court orders</li>
        <li style={s.li}>Changes to APIs, terms of service, or policies of third-party services that affect Platform functionality</li>
        <li style={s.li}>Power outages, hardware failures, or infrastructure damage</li>
        <li style={s.li}>Any other event beyond the Company{"'"}s reasonable control</li>
      </ul>
      <p style={s.p}>If a force majeure event prevents the Company from performing, the Company{"'"}s obligations are suspended for the duration of the event. The Company is not required to provide refunds, credits, or compensation for downtime, lost data, or other harm caused by force majeure events.</p>

      <h2 style={s.h2}>13. Disclaimer of Warranties</h2>
      <p style={s.p}><strong>THE PLATFORM IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY.</strong> To the fullest extent permitted by law, we disclaim all warranties, including but not limited to implied warranties of merchantability, fitness for a particular purpose, non-infringement, and any warranties arising from course of dealing or usage of trade.</p>
      <p style={s.p}>We do not warrant that: the Platform will meet your specific requirements; the Platform will be uninterrupted, timely, secure, or error-free; the results obtained from using the Platform will be accurate or reliable; or any errors will be corrected.</p>

      <h2 style={s.h2}>14. Limitation of Liability</h2>
      <p style={s.p}><strong>TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE COMPANY, ITS OFFICERS, DIRECTORS, EMPLOYEES, AGENTS, AND AFFILIATES SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES</strong>, including but not limited to loss of profits, data, business opportunities, goodwill, or other intangible losses, arising out of or in connection with your use of or inability to use the Platform, even if we have been advised of the possibility of such damages.</p>
      <p style={s.p}>Our total aggregate liability for any and all claims arising from or related to these Terms or the Platform shall not exceed the greater of: (a) the total fees you have paid to us in the six (6) months preceding the claim; or (b) one hundred dollars ($100.00 USD).</p>

      <h2 style={s.h2}>15. Indemnification</h2>
      <p style={s.p}>You agree to indemnify, defend, and hold harmless the Company and its officers, directors, employees, agents, and affiliates from and against any and all claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys{"'"} fees) arising out of or related to: (a) your use of the Platform; (b) your violation of these Terms; (c) your violation of any applicable law or third-party right; (d) any content you create, upload, or distribute through the Platform; or (e) any dispute between you and your customers or contacts.</p>

      <h2 style={s.h2}>16. Dispute Resolution and Arbitration</h2>
      <p style={s.p}><strong>Binding Arbitration:</strong> Any dispute, controversy, or claim arising out of or relating to these Terms or the Platform shall be resolved by binding arbitration administered in accordance with the rules of the American Arbitration Association. The arbitration shall be conducted in the State of Wyoming, and the arbitrator{"'"}s decision shall be final and binding.</p>
      <p style={s.p}><strong>Class Action Waiver:</strong> You agree that any dispute resolution proceedings will be conducted only on an individual basis and not in a class, consolidated, or representative action. You waive any right to participate in a class action lawsuit or class-wide arbitration.</p>
      <p style={s.p}><strong>Jury Trial Waiver:</strong> To the fullest extent permitted by law, you waive any right to a jury trial in any dispute arising from these Terms.</p>
      <p style={s.p}><strong>Exception:</strong> Either party may seek injunctive or other equitable relief in any court of competent jurisdiction to prevent the actual or threatened infringement of intellectual property rights.</p>

      <h2 style={s.h2}>17. Termination, Suspension, and Refusal of Service</h2>

      <h3 style={s.h3}>17.1 Termination by You</h3>
      <p style={s.p}>You may terminate your account at any time by contacting the Company. Termination by you does not entitle you to any refund or credit of any fees previously paid.</p>

      <h3 style={s.h3}>17.2 Termination by the Company</h3>
      <p style={s.p}>The Company may suspend or terminate your account, restrict your access to all or part of the Platform, or refuse to provide service to you, at any time, with or without cause, with or without notice, in its sole discretion. Reasons for suspension or termination may include but are not limited to:</p>
      <ul style={s.ul}>
        <li style={s.li}>Violation of these Terms or the Acceptable Use Policy</li>
        <li style={s.li}>Suspected fraudulent, illegal, or abusive activity</li>
        <li style={s.li}>Non-payment or chargebacks</li>
        <li style={s.li}>Risk to other users, the Platform, or the Company</li>
        <li style={s.li}>Compliance with legal obligations or government requests</li>
        <li style={s.li}>Discontinuation of the Platform or any feature thereof</li>
      </ul>

      <h3 style={s.h3}>17.3 No Refund Upon Termination for Cause</h3>
      <p style={s.p}><strong>If your account is suspended or terminated for violation of these Terms, the Acceptable Use Policy, or for any cause attributable to your conduct, you forfeit all fees previously paid and are not entitled to any refund, credit, pro-rated reimbursement, or compensation of any kind.</strong> The Company is not liable for any loss, damage, or harm resulting from termination for cause.</p>

      <h3 style={s.h3}>17.4 Right to Refuse Service</h3>
      <p style={s.p}>The Company reserves the right to refuse service to anyone, at any time, for any non-discriminatory reason, with or without explanation. The Company is not obligated to provide a reason for refusing service.</p>

      <h3 style={s.h3}>17.5 Effect of Termination</h3>
      <p style={s.p}>Upon termination: your right to access the Platform ceases immediately; the Company will delete your User Data within 30 days (except where legally required to retain); pending or scheduled communications, automations, or workflows will cease; any outstanding fees become immediately due; and any provisions of these Terms that by their nature should survive termination will survive (see Section 24, Survival).</p>

      <h3 style={s.h3}>17.6 Data Export Before Termination</h3>
      <p style={s.p}>You are responsible for exporting any data you wish to retain before terminating your account. The Company is not obligated to provide data export assistance after termination, and may not be able to recover deleted data.</p>

      <h2 style={s.h2}>18. Governing Law</h2>
      <p style={s.p}>These Terms shall be governed by and construed in accordance with the laws of the State of Wyoming, United States, without regard to its conflict of law provisions.</p>

      <h2 style={s.h2}>19. Export Control and Restricted Persons</h2>
      <p style={s.p}>The Platform may be subject to United States and other jurisdictions{"'"} export control laws and economic sanctions regulations. You represent, warrant, and agree that:</p>
      <ul style={s.ul}>
        <li style={s.li}>You are not located in, under the control of, or a national or resident of any country subject to a comprehensive U.S. embargo, including but not limited to Cuba, Iran, North Korea, Syria, the Crimea region of Ukraine, the so-called Donetsk People{"'"}s Republic, or the so-called Luhansk People{"'"}s Republic</li>
        <li style={s.li}>You are not listed on any U.S. government list of prohibited or restricted parties, including the Treasury Department{"'"}s list of Specially Designated Nationals (SDN), the Commerce Department{"'"}s Denied Persons List, Entity List, or Unverified List, or any equivalent list maintained by other governments</li>
        <li style={s.li}>You will not use the Platform for any purpose prohibited by U.S. export control laws, including the development, design, manufacture, or production of nuclear, missile, chemical, or biological weapons</li>
        <li style={s.li}>You will not export, re-export, transfer, or make available the Platform to any person or country in violation of applicable export control or sanctions laws</li>
      </ul>
      <p style={s.p}>The Company may terminate your access immediately if you violate this Section.</p>

      <h2 style={s.h2}>20. Assumption of Risk</h2>
      <p style={s.p}>The Platform is a business tool. The Company does not guarantee any specific business outcomes, revenue, leads, conversions, or results from using the Platform. Your business success depends on many factors beyond our control. You assume all risk associated with your business decisions and use of the Platform, including any decisions made based on AI-generated output, automated workflows, or Platform analytics.</p>

      <h2 style={s.h2}>21. Modifications to Terms</h2>
      <p style={s.p}>We reserve the right to modify these Terms at any time. Material changes will be communicated via email or in-app notification at least 14 days before taking effect. Non-material changes (typos, clarifications, formatting) may be made without notice. Continued use of the Platform after changes take effect constitutes acceptance of the updated Terms. If you disagree with any changes, you must stop using the Platform and delete your account before the changes take effect.</p>

      <h2 style={s.h2}>22. Anonymized and Aggregated Data</h2>
      <p style={s.p}>The Company may collect, use, and share anonymized and aggregated data derived from your use of the Platform for any business purpose, including but not limited to: improving the Platform, analyzing usage patterns, developing new features, marketing, research, benchmarking, and publishing industry insights. Anonymized data is data from which all personally identifiable information has been removed and cannot reasonably be re-associated with any individual. The Company will not include any personal information about you, your contacts, or your customers in anonymized data shared publicly.</p>

      <h2 style={s.h2}>23. Survival</h2>
      <p style={s.p}>The following sections of these Terms survive any termination or expiration and remain in full force and effect: Section 3 (Your Data and Ownership), Section 6 (AI-Powered Features — User Responsibility), Section 7 (User Responsibility for Data Protection and Information Security), Section 8 (Beta Features), Section 10 (Intellectual Property), Section 13 (Disclaimer of Warranties), Section 14 (Limitation of Liability), Section 15 (Indemnification), Section 16 (Dispute Resolution and Arbitration), Section 17.3 (No Refund Upon Termination for Cause), Section 18 (Governing Law), Section 19 (Export Control), Section 20 (Assumption of Risk), Section 22 (Anonymized and Aggregated Data), this Section 23 (Survival), and any other provision that by its nature is intended to survive termination.</p>

      <h2 style={s.h2}>24. Miscellaneous</h2>
      <ul style={s.ul}>
        <li style={s.li}><strong>Entire Agreement:</strong> These Terms, together with the Privacy Policy, constitute the entire agreement between you and the Company regarding the Platform.</li>
        <li style={s.li}><strong>Severability:</strong> If any provision is found unenforceable, the remaining provisions remain in full force and effect.</li>
        <li style={s.li}><strong>Waiver:</strong> Failure to enforce any provision does not constitute a waiver of that provision.</li>
        <li style={s.li}><strong>Assignment:</strong> You may not assign these Terms without our written consent. We may assign these Terms in connection with a merger, acquisition, or sale of assets.</li>
        <li style={s.li}><strong>No Third-Party Beneficiaries:</strong> These Terms do not confer any rights on third parties.</li>
        <li style={s.li}><strong>Electronic Communications:</strong> By using the Platform, you consent to receiving electronic communications from us and agree that such communications satisfy any legal requirement for written communication.</li>
      </ul>

      <h2 style={s.h2}>25. Contact Information</h2>
      <p style={s.p}>The Services are offered by The Launch Pad LLC. You may contact us by email at: <a href="mailto:hello@thelaunchpadincubator.com" style={s.link}>hello@thelaunchpadincubator.com</a>.</p>

      <div style={s.footer}>
        <p><a href="/privacy" style={s.link}>Privacy Policy</a> · <a href="/login" style={s.link}>Back to LaunchOS</a></p>
        <p style={{ marginTop: 8, color: '#bbb' }}>© {new Date().getFullYear()} The Launch Pad LLC. All rights reserved.</p>
      </div>
    </div>
  )
}
