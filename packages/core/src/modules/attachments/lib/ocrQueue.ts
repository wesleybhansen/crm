import type { EntityManager } from '@mikro-orm/postgresql'
import { Attachment, AttachmentPartition } from '../data/entities'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import { logCrmAiUsage } from '@open-mercato/shared/lib/noli/ai-usage'
import { OcrService } from './ocrService'

export type OcrRequestedEvent = {
  attachmentId: string
  filePath: string
  mimeType: string
  partitionCode: string
  organizationId: string | null
  tenantId: string | null
}

export async function processAttachmentOcr(
  em: EntityManager,
  payload: OcrRequestedEvent
): Promise<void> {
  const { attachmentId, filePath, mimeType, partitionCode } = payload

  console.log(`[attachments.ocr] Processing started for attachment: ${attachmentId}`)
  const startTime = Date.now()

  try {
    const partition = await em.findOne(AttachmentPartition, { code: partitionCode })
    const resolvedModel = partition?.ocrModel ?? process.env.OCR_MODEL ?? 'gpt-4o'

    const ocrService = new OcrService()

    if (!ocrService.available) {
      console.warn(`[attachments.ocr] OPENAI_API_KEY not configured, skipping OCR for: ${attachmentId}`)
      return
    }

    const result = await ocrService.processFile({
      filePath,
      mimeType,
      model: resolvedModel,
    })

    if (!result) {
      console.log(`[attachments.ocr] No content extracted for attachment: ${attachmentId}`)
      return
    }

    const attachment = await em.findOne(Attachment, { id: attachmentId })
    if (!attachment) {
      console.error(`[attachments.ocr] Attachment not found: ${attachmentId}`)
      return
    }

    attachment.content = result.content
    await em.persistAndFlush(attachment)

    // Cross-product usage metering (fire-and-forget; never breaks OCR).
    try {
      if (payload.organizationId && ((result.tokensIn ?? 0) > 0 || (result.tokensOut ?? 0) > 0)) {
        const org = await em.findOne(Organization, { id: payload.organizationId })
        if (org?.noliOrgId) {
          void logCrmAiUsage({
            noliOrgId: org.noliOrgId,
            model: result.model ?? resolvedModel,
            tokensIn: result.tokensIn ?? 0,
            tokensOut: result.tokensOut ?? 0,
            feature: 'attachment-ocr',
          }).catch(() => {})
        }
      }
    } catch {
      /* ignore — metering is best-effort */
    }

    console.log(`[attachments.ocr] Processing completed:`, {
      attachmentId,
      pageCount: result.pageCount,
      contentLength: result.content.length,
      timeMs: result.processingTimeMs,
      totalTimeMs: Date.now() - startTime,
    })
  } catch (error) {
    console.error(`[attachments.ocr] Processing failed:`, {
      attachmentId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function requestOcrProcessing(
  em: EntityManager,
  attachment: Attachment,
  filePath: string
): Promise<void> {
  const payload: OcrRequestedEvent = {
    attachmentId: attachment.id,
    filePath,
    mimeType: attachment.mimeType,
    partitionCode: attachment.partitionCode,
    organizationId: attachment.organizationId ?? null,
    tenantId: attachment.tenantId ?? null,
  }

  setImmediate(() => {
    const workerEm = typeof (em as any)?.fork === 'function' ? (em as any).fork() : em
    processAttachmentOcr(workerEm, payload).catch((error) => {
      console.error(`[attachments.ocr] Background processing error:`, error)
    })
  })
}
