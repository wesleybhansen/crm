export const metadata = { POST: { requireAuth: true } }
export const openApi = { summary: 'publish', methods: {} }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { query, queryOne } from '@/lib/db'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { isWizardV2Config, renderWizardPageHtml, wizardFieldsToLandingFormFields, wizardSections } from '../../../../services/wizard-publish'

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function convertWizardFieldsToFormFields(wizardFields: { label: string; type: string; required: boolean }[]) {
  return wizardFields.map((f) => {
    const id = f.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    let crmMapping: string | undefined
    if (f.type === 'email') crmMapping = 'primary_email'
    else if (f.label.toLowerCase().includes('name')) crmMapping = 'display_name'
    else if (f.type === 'tel' || f.label.toLowerCase().includes('phone')) crmMapping = 'primary_phone'
    return { id, label: f.label, type: f.type === 'tel' ? 'phone' : f.type, required: f.required, crmMapping }
  })
}

type PublishAuth = { tenantId?: string | null; orgId?: string | null }

/**
 * Keep the page's form records in step with the wizard's form fields.
 *  - landing_page_forms: what the public submit endpoint reads. Required.
 *  - forms: a copy listed under Forms. It is created as a DRAFT (never
 *    silently published) and a failure here does not block the page.
 * Returns the newly created Forms copy, so the UI can tell the user.
 */
async function syncWizardForms(opts: { page: any; config: Record<string, any>; pageId: string; auth: PublishAuth }) {
  const { page, config, pageId, auth } = opts
  const now = new Date()
  let createdForm: { id: string; name: string; status: 'draft' } | null = null

  const formFields = convertWizardFieldsToFormFields(config.formFields || [])
  const formSettings: Record<string, unknown> = {
    source: 'landing-page',
    landingPageSlug: page.slug,
    tags: ['landing-page:' + page.slug],
    successMessage: 'Thank you! We\'ll be in touch.',
    ...(config.pipelineStage ? { pipelineStage: config.pipelineStage } : {}),
    ...(config.leadMagnet?.downloadUrl ? {
      redirectUrl: config.leadMagnet.downloadUrl,
      leadMagnet: config.leadMagnet,
    } : {}),
  }
  const formName = page.title + ' Form'

  try {
    if (config.linkedFormId) {
      // Update the existing copy; its draft/published status is the user's call.
      await query(
        'UPDATE forms SET name = $1, fields = $2, settings = $3, updated_at = $4 WHERE id = $5 AND organization_id = $6',
        [formName, JSON.stringify(formFields), JSON.stringify(formSettings), now, config.linkedFormId, auth.orgId]
      )
    } else {
      const formId = crypto.randomUUID()
      const ownFormSlug = page.slug + '-form'
      // Form slugs are public and unique across every organisation.
      let formSlug = ownFormSlug
      for (let attempt = 0; attempt < 8; attempt++) {
        const taken = await queryOne('SELECT id FROM forms WHERE slug = $1 LIMIT 1', [formSlug])
        if (!taken) break
        formSlug = `${ownFormSlug}-${crypto.randomBytes(3).toString('hex')}`
      }
      await query(
        `INSERT INTO forms (id, tenant_id, organization_id, name, slug, fields, settings, status, is_active, created_at, updated_at, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', false, $8, $8, NULL)`,
        [formId, auth.tenantId, auth.orgId, formName, formSlug, JSON.stringify(formFields), JSON.stringify(formSettings), now]
      )
      config.linkedFormId = formId
      createdForm = { id: formId, name: formName, status: 'draft' }
      await query('UPDATE landing_pages SET config = $1 WHERE id = $2', [JSON.stringify(config), pageId])
    }
  } catch (e) {
    // The page's own form (below) is what takes submissions; the Forms copy is optional.
    console.error('[pages.publish] Could not save the Forms copy of this page\'s form', { pageId }, e)
    createdForm = null
  }

  // The form the public submit endpoint reads. tenant_id and organization_id
  // are NOT NULL; leaving them out made every wizard publish fail.
  const lpFormFields = wizardFieldsToLandingFormFields(config.formFields)
  const successMessage = 'Thank you! We\'ll be in touch.'
  const redirectUrl = config.leadMagnet?.downloadUrl || null
  const existingLpForm = await queryOne('SELECT id FROM landing_page_forms WHERE landing_page_id = $1', [pageId])
  if (existingLpForm) {
    await query(
      'UPDATE landing_page_forms SET fields = $1, success_message = $2, redirect_url = $3, updated_at = $4 WHERE id = $5',
      [JSON.stringify(lpFormFields), successMessage, redirectUrl, now, existingLpForm.id]
    )
  } else {
    await query(
      `INSERT INTO landing_page_forms (id, tenant_id, organization_id, landing_page_id, name, fields, success_message, redirect_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'default', $5, $6, $7, $8, $8)`,
      [crypto.randomUUID(), page.tenant_id || auth.tenantId, page.organization_id || auth.orgId, pageId, JSON.stringify(lpFormFields), successMessage, redirectUrl, now]
    )
  }

  return createdForm
}

function renderSectionsToHtml(sections: any[], templateHtml: string, formAction: string, pageTitle: string): string {
  // If we have the original template HTML and sections with their html fragments,
  // rebuild by replacing section content with edited fields

  // For each section, update its HTML based on edited fields
  let resultHtml = templateHtml

  for (const section of sections) {
    if (!section.html || !section.fields) continue

    let sectionHtml = section.html

    // Replace text content based on field edits
    if (section.fields.headline) {
      sectionHtml = sectionHtml.replace(/<h1([^>]*)>[\s\S]*?<\/h1>/i, `<h1$1>${escapeHtml(section.fields.headline)}</h1>`)
    }
    if (section.fields.subheadline) {
      sectionHtml = sectionHtml.replace(/<h2([^>]*)>[\s\S]*?<\/h2>/i, `<h2$1>${escapeHtml(section.fields.subheadline)}</h2>`)
    }
    if (section.fields.ctaText) {
      // Replace button text
      sectionHtml = sectionHtml.replace(/(<(?:a|button)[^>]*class="[^"]*(?:btn|button|cta)[^"]*"[^>]*>)[\s\S]*?(<\/(?:a|button)>)/i,
        `$1${escapeHtml(section.fields.ctaText)}$2`)
    }
    if (section.fields.ctaUrl) {
      sectionHtml = sectionHtml.replace(/(href=")([^"]*)(")/, `$1${section.fields.ctaUrl}$3`)
    }

    // Replace this section in the result
    if (section.html && resultHtml.includes(section.html)) {
      resultHtml = resultHtml.replace(section.html, sectionHtml)
    }
  }

  // Inject form handler
  if (!resultHtml.includes(formAction)) {
    const formScript = `<script>
(function(){document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){e.preventDefault();var d={};new FormData(f).forEach(function(v,k){d[k]=v});var b=f.querySelector('[type="submit"]');if(b){b.disabled=true;b.textContent='Sending...';}fetch('${formAction}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:d})}).then(function(r){return r.json()}).then(function(r){if(r.ok){if(r.redirectUrl){window.location.href=r.redirectUrl}else{f.innerHTML='<div style="text-align:center;padding:24px"><h3 style="margin-bottom:8px">Thank you!</h3><p>'+(r.message||"We will be in touch.")+'</p></div>'}}else{alert(r.error||'Something went wrong');if(b){b.disabled=false;b.textContent='Submit'}}}).catch(function(){if(b){b.disabled=false;b.textContent='Try Again'}})})})})();
</script>`
    resultHtml = resultHtml.replace('</body>', formScript + '\n</body>')
  }

  // Update title
  resultHtml = resultHtml.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(pageTitle)}</title>`)

  return resultHtml
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { id } = await params
    const page = await queryOne('SELECT * FROM landing_pages WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [id, auth.orgId])
    if (!page) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    const config = typeof page.config === 'string' ? JSON.parse(page.config) : (page.config || {})
    const baseUrl = process.env.APP_URL || 'http://localhost:3000'
    const formAction = `${baseUrl}/api/landing_pages/public/${page.slug}/submit`

    let html: string | null = null

    // Wizard v2: section-based renderer with style tokens
    let formNotice: { id: string; name: string; status: 'draft' } | null = null
    if (isWizardV2Config(config) && wizardSections(config).length > 0) {
      try {
        html = renderWizardPageHtml(config, { title: page.title, slug: page.slug }, formAction)
      } catch (e) {
        console.error('[pages.publish] Wizard page rendering failed', {
          pageId: id,
          styleId: config.styleId ?? null,
          pageType: config.pageType ?? null,
          sectionTypes: wizardSections(config).map((s) => s.type),
        }, e)
        const reason = e instanceof Error ? e.message : String(e)
        return NextResponse.json({ ok: false, error: `Could not build this page: ${reason}` }, { status: 422 })
      }

      const isBookingPage = !!config.bookingPageSlug
      const isUpsellOrDownsell = config.pageType === 'upsell' || config.pageType === 'downsell'
      if (!isBookingPage && !isUpsellOrDownsell) {
        formNotice = await syncWizardForms({ page, config, pageId: id, auth })
      }
    }

    // Legacy: If we have sections in config, rebuild from them + template
    if (!html && config.sections && config.sections.length > 0 && page.template_id) {
      try {
        const templatesDir = path.join(process.cwd(), 'templates')
        const templatePath = path.join(templatesDir, page.template_id, 'index.html')
        if (fs.existsSync(templatePath)) {
          const templateHtml = fs.readFileSync(templatePath, 'utf-8')
          html = renderSectionsToHtml(config.sections, templateHtml, formAction, page.title)
        }
      } catch (e) {
        console.error('[pages.publish] Section rendering failed:', e)
      }
    }

    // Fallback: use existing published_html (from AI generation) and just update form handler
    const publishedHtml = page.published_html

    // Fallback: use existing published_html (from AI generation) and just update form handler
    if (!html && publishedHtml) {
      let fallbackHtml = publishedHtml
      // Ensure form handler points to correct URL
      if (!fallbackHtml.includes(formAction)) {
        const formScript = `<script>
(function(){document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){e.preventDefault();var d={};new FormData(f).forEach(function(v,k){d[k]=v});var b=f.querySelector('[type="submit"]');if(b){b.disabled=true;b.textContent='Sending...';}fetch('${formAction}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:d})}).then(function(r){return r.json()}).then(function(r){if(r.ok){if(r.redirectUrl){window.location.href=r.redirectUrl}else{f.innerHTML='<div style="text-align:center;padding:24px"><h3>Thank you!</h3><p>'+(r.message||"We will be in touch.")+'</p></div>'}}}).catch(function(){if(b){b.disabled=false;b.textContent='Try Again'}})})})})();
</script>`
        fallbackHtml = fallbackHtml.replace('</body>', formScript + '\n</body>')
      }
      html = fallbackHtml
    }

    // Fallback: read template directly
    if (!html && page.template_id) {
      try {
        const templatesDir = path.join(process.cwd(), 'templates')
        const templatePath = path.join(templatesDir, page.template_id, 'index.html')
        if (fs.existsSync(templatePath)) {
          html = fs.readFileSync(templatePath, 'utf-8')
          const formScript = `<script>
(function(){document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){e.preventDefault();var d={};new FormData(f).forEach(function(v,k){d[k]=v});var b=f.querySelector('[type="submit"]');if(b){b.disabled=true;b.textContent='Sending...';}fetch('${formAction}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:d})}).then(function(r){return r.json()}).then(function(r){if(r.ok){if(r.redirectUrl){window.location.href=r.redirectUrl}else{f.innerHTML='<div style="text-align:center;padding:24px"><h3>Thank you!</h3><p>'+(r.message||"We will be in touch.")+'</p></div>'}}}).catch(function(){if(b){b.disabled=false;b.textContent='Try Again'}})})})})();
</script>`
          html = html.replace('</body>', formScript + '\n</body>')
        }
      } catch {}
    }

    if (!html) {
      return NextResponse.json({ ok: false, error: 'Could not generate page HTML. Please select a template or generate content first.' }, { status: 400 })
    }

    // Save and publish
    await query(
      'UPDATE landing_pages SET published_html = $1, status = $2, published_at = COALESCE(published_at, $3), updated_at = $3 WHERE id = $4',
      [html, 'published', new Date(), id]
    )

    return NextResponse.json({ ok: true, data: { status: 'published', ...(formNotice ? { createdForm: formNotice } : {}) } })
  } catch (error) {
    console.error('[pages.publish]', error)
    return NextResponse.json({ ok: false, error: 'Failed to publish' }, { status: 500 })
  }
}
