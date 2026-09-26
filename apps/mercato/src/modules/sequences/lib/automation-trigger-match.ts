/**
 * Trigger-config matching for automation rules (automation_rules) and
 * trigger-based sequences (sequences.trigger_config).
 *
 * Tag triggers: the Automations builder and the Sequences editor both fill the
 * tag picker from /api/crm-contact-tags and save the chosen tag's ID under the
 * historical key `tagSlug`, while the tag routes report the tag's slug. The old
 * comparison (`config.tagSlug !== context.tagSlug`) compared an id with a slug,
 * so a trigger set to one specific tag never fired. Recipes, the AI generator
 * and older rules save a real slug (or a label) under the same key, so a
 * configured value names the tag when it equals the tag's id, its slug, or its
 * label slugified the way the tag routes build slugs.
 *
 * Pure, no imports: the dispatch subscribers bundle this into the queue workers.
 */

type Config = Record<string, unknown> | null | undefined
type Context = Record<string, unknown>

/** The slug the tag routes build from a tag name (crm-contact-tags, add_tag). */
export function slugifyTag(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function norm(value: unknown): string {
  return text(value).toLowerCase()
}

/** True when one configured value names the event's tag, by id, slug or label. */
function namesTag(wanted: string, event: Context): boolean {
  const lowered = wanted.toLowerCase()
  const id = norm(event.tagId)
  if (id && lowered === id) return true
  const wantedSlug = slugifyTag(wanted)
  if (!wantedSlug) return false
  const slug = norm(event.tagSlug)
  if (slug && (lowered === slug || wantedSlug === slugifyTag(slug))) return true
  const label = slugifyTag(event.tagName)
  return !!label && wantedSlug === label
}

/**
 * A tag trigger with no tag configured matches every tag. Otherwise every
 * configured value (tagId, tagSlug, tagName) must name the event's tag.
 */
export function tagTriggerMatches(config: Config, event: Context): boolean {
  if (!config) return true
  const wanted = [config.tagId, config.tagSlug, config.tagName].map(text).filter(Boolean)
  return wanted.every((value) => namesTag(value, event))
}

/**
 * Contact source filter. Case-insensitive; a category also matches its
 * detailed form, so "landing_page" matches "landing_page:google" (the landing
 * page route stores the UTM source after a colon) and "api" matches
 * "api:<key name>".
 */
export function sourceMatches(wanted: unknown, actual: unknown): boolean {
  const w = norm(wanted)
  if (!w) return true
  const a = norm(actual)
  if (!a) return false
  return a === w || a.startsWith(`${w}:`)
}

function sameStage(a: unknown, b: unknown): boolean {
  return norm(a) === norm(b)
}

function sameId(wanted: unknown, actual: unknown): boolean {
  const w = text(wanted)
  return !w || w === text(actual)
}

/** Does an automation rule's trigger_config accept this event? */
export function matchesTriggerConfig(triggerType: string, triggerConfig: Config, context: Context): boolean {
  if (!triggerConfig || Object.keys(triggerConfig).length === 0) return true

  switch (triggerType) {
    case 'tag_added':
    case 'tag_removed':
      return tagTriggerMatches(triggerConfig, context)

    case 'form_submitted':
      if (!sameId(triggerConfig.formId, context.formId)) return false
      if (!sameId(triggerConfig.landingPageSlug, context.landingPageSlug)) return false
      return true

    case 'deal_won':
    case 'deal_lost':
      return sameId(triggerConfig.pipelineId, context.pipelineId)

    case 'contact_created':
    case 'contact_updated':
    case 'company_created':
      return sourceMatches(triggerConfig.source, context.source)

    case 'stage_change': {
      // `stage` is the journey-board spelling of `toStage`; names match case-insensitively.
      const wantTo = triggerConfig.toStage ?? triggerConfig.stage
      if (text(triggerConfig.fromStage) && !sameStage(triggerConfig.fromStage, context.fromStage)) return false
      if (text(wantTo) && !sameStage(wantTo, context.toStage)) return false
      return true
    }

    default:
      return true
  }
}

/** Does a trigger-based sequence's trigger_config accept this event? */
export function matchesSequenceTrigger(triggerType: string, config: Config, context: Context): boolean {
  if (!config || Object.keys(config).length === 0) return true
  switch (triggerType) {
    case 'tag_added':
      return tagTriggerMatches(config, context)
    case 'deal_stage_changed':
      return !text(config.stage) || sameStage(config.stage, context.stage)
    case 'form_submit':
      return sameId(config.formId, context.formId)
    case 'booking_created':
      return sameId(config.bookingPageId, context.bookingPageId)
    case 'contact_created':
      return sourceMatches(config.source, context.source)
    default:
      return true
  }
}
