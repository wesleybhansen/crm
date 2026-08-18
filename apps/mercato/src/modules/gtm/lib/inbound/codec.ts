import { decryptWithAesGcmStrict, encryptWithAesGcm } from '@open-mercato/shared/lib/encryption/aes'
import crypto from 'node:crypto'
import type { CursorCodec, CursorContext } from './cursor'

function scopeHash(context: CursorContext): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    organizationId: context.organizationId,
    tenantId: context.tenantId,
    mailboxConnectionId: context.mailboxConnectionId,
    provider: context.provider,
    cursorKind: context.cursorKind,
  })).digest('hex')
}

export function createTenantCursorCodec(dekBase64: string): CursorCodec {
  return {
    async seal(value, context) {
      const plaintext = JSON.stringify({ scope: scopeHash(context), value })
      const encrypted = encryptWithAesGcm(plaintext, dekBase64).value
      if (!encrypted) throw new Error('cursor encryption failed')
      return encrypted
    },
    async unseal(value, context) {
      const plaintext = decryptWithAesGcmStrict(value, dekBase64)
      const parsed = JSON.parse(plaintext) as { scope?: unknown; value?: unknown }
      if (parsed.scope !== scopeHash(context) || typeof parsed.value !== 'string') {
        throw new Error('cursor scope integrity failed')
      }
      return parsed.value
    },
  }
}
