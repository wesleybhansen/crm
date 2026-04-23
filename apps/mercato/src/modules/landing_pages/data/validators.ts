import { z } from 'zod'

export const createLandingPageSchema = z.object({
  title: z.string().min(1).max(200),
  slug: z.string().min(1).max(200).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers, and hyphens'),
  templateId: z.string().max(100).optional().nullable(),
  templateCategory: z.string().max(50).optional().nullable(),
  config: z.record(z.string(), z.any()).optional().nullable(),
})

export const updateLandingPageSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  slug: z.string().min(1).max(200).regex(/^[a-z0-9-]+$/).optional(),
  templateId: z.string().max(100).optional().nullable(),
  templateCategory: z.string().max(50).optional().nullable(),
  config: z.record(z.string(), z.any()).optional().nullable(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  customDomain: z.string().max(255).optional().nullable(),
  publishedHtml: z.string().optional().nullable(),
}).refine((data) => Object.keys(data).length > 0, { message: 'At least one field must be provided' })

export const formFieldSchema = z.object({
  name: z.string().min(1).max(50),
  type: z.enum(['text', 'email', 'phone', 'textarea', 'select', 'checkbox']),
  label: z.string().min(1).max(100),
  required: z.boolean(),
  placeholder: z.string().max(200).optional(),
  options: z.array(z.string()).optional(),
})

export const createFormSchema = z.object({
  landingPageId: z.string().uuid(),
  name: z.string().min(1).max(100).default('default'),
  fields: z.array(formFieldSchema).min(1).max(20),
  redirectUrl: z.string().url().optional().nullable(),
  notificationEmail: z.string().email().optional().nullable(),
  successMessage: z.string().max(500).optional().nullable(),
})

export const submitFormSchema = z.object({
  data: z.record(z.string(), z.any()),
})

export const listLandingPagesSchema = z.object({
  status: z.enum(['draft', 'published', 'archived']).optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
})

export type CreateLandingPage = z.infer<typeof createLandingPageSchema>
export type UpdateLandingPage = z.infer<typeof updateLandingPageSchema>
export type CreateForm = z.infer<typeof createFormSchema>
export type SubmitForm = z.infer<typeof submitFormSchema>
