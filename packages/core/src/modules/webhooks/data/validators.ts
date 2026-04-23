import { z } from 'zod'

export const subscriptionCreateSchema = z.object({
  event: z.string().trim().min(1).max(100),
  targetUrl: z.string().trim().url().max(2000),
  secret: z.string().trim().max(256).optional().nullable(),
  isActive: z.boolean().optional(),
})

export const subscriptionUpdateSchema = z.object({
  id: z.string().uuid(),
  event: z.string().trim().min(1).max(100).optional(),
  targetUrl: z.string().trim().url().max(2000).optional(),
  secret: z.string().trim().max(256).optional().nullable(),
  isActive: z.boolean().optional(),
})

export type SubscriptionCreateInput = z.infer<typeof subscriptionCreateSchema>
export type SubscriptionUpdateInput = z.infer<typeof subscriptionUpdateSchema>
