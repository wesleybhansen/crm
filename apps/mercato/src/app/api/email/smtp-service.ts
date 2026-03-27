/**
 * SMTP Service
 * Send emails via a generic SMTP server using nodemailer.
 */

interface SmtpConfig {
  host: string
  port: number
  username: string
  password: string
}

interface SmtpSendResult {
  messageId: string
}

/**
 * Send an email via SMTP using nodemailer.
 */
export async function sendViaSMTP(
  config: SmtpConfig,
  from: string,
  to: string,
  subject: string,
  htmlBody: string,
  textBody?: string,
): Promise<SmtpSendResult> {
  const nodemailer = await import('nodemailer')

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: {
      user: config.username,
      pass: config.password,
    },
  })

  const info = await transporter.sendMail({
    from,
    to,
    subject,
    html: htmlBody,
    text: textBody || htmlBody.replace(/<[^>]+>/g, ''),
  })

  return {
    messageId: info.messageId || '',
  }
}
