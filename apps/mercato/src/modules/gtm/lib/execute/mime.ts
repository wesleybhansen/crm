import crypto from 'node:crypto'

export type GtmMimeInput = {
  from: string
  to: string
  subject: string
  html: string
  text: string
  headers: Record<string, string>
  messageId: string
}

function requireHeaderValue(label: string, value: string, maxLength: number): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength || /[\r\n\0]/.test(trimmed)) {
    throw new Error(`invalid ${label}`)
  }
  return trimmed
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function encodeBody(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .match(/.{1,76}/g)
    ?.join('\r\n') ?? ''
}

export function buildGtmMimeMessage(input: GtmMimeInput): string {
  const from = requireHeaderValue('from address', input.from, 320)
  const to = requireHeaderValue('recipient address', input.to, 320)
  const subject = requireHeaderValue('subject', input.subject, 998)
  const messageId = requireHeaderValue('message id', input.messageId, 998)
  if (!/^<[^<>\s@]+@[^<>\s@]+>$/.test(messageId)) {
    throw new Error('invalid message id')
  }
  const extraHeaders = Object.entries(input.headers).map(([name, value]) => {
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error('invalid header name')
    return `${name}: ${requireHeaderValue(`header ${name}`, value, 4096)}`
  })
  const boundary = `noli_gtm_${crypto.createHash('sha256').update(messageId).digest('hex').slice(0, 32)}`
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: ${messageId}`,
    ...extraHeaders,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBody(input.text),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBody(input.html),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

export function encodeGmailRaw(mime: string): string {
  return Buffer.from(mime, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function encodeGraphMime(mime: string): string {
  return Buffer.from(mime, 'utf8').toString('base64')
}
