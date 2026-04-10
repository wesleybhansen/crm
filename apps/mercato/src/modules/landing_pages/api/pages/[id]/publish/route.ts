export const metadata = { POST: { requireAuth: true } }
export const openApi = { summary: 'publish', methods: {} }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { query, queryOne } from '@/app/api/funnels/db'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

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
    const formAction = `${baseUrl}/api/landing-pages/public/${page.slug}/submit`

    let html: string | null = null

    // Wizard v2: section-based renderer with style tokens
    if (config?.wizardVersion === 2 && config?.generatedSections && config?.styleId) {
      try {
        const { assemblePage, assembleSimplePage } = await import('@/lib/landing-page-wizard/page-assembler')
        const { getStyleById } = await import('@/lib/landing-page-wizard/styles')
        const style = getStyleById(config.styleId)
        if (style) {
          const isBookingPage = !!config.bookingPageSlug
          const isUpsellOrDownsell = config.pageType === 'upsell' || config.pageType === 'downsell'

          // Create/update forms record for pages that have forms (not booking, upsell, or downsell)
          let v2FormAction = `${baseUrl}/api/landing-pages/public/${page.slug}/submit`

          if (!isBookingPage && !isUpsellOrDownsell) {
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

            if (config.linkedFormId) {
              // Update existing form
              await query(
                'UPDATE forms SET name = $1, fields = $2, settings = $3, updated_at = $4 WHERE id = $5',
                [page.title + ' Form', JSON.stringify(formFields), JSON.stringify(formSettings), new Date(), config.linkedFormId]
              )
            } else {
              // Create new form
              const formId = crypto.randomUUID()
              const formSlug = page.slug + '-form'
              const existingForm = await queryOne('SELECT id FROM forms WHERE slug = $1 AND organization_id = $2', [formSlug, auth.orgId])
              const finalFormSlug = existingForm ? formSlug + '-' + Date.now() : formSlug

              await query(
                `INSERT INTO forms (id, tenant_id, organization_id, name, slug, fields, settings, status, is_active, created_at, updated_at, published_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'published', true, $8, $8, $8)`,
                [formId, auth.tenantId, auth.orgId, page.title + ' Form', finalFormSlug, JSON.stringify(formFields), JSON.stringify(formSettings), new Date()]
              )
              config.linkedFormId = formId
            }

            // Update config with linkedFormId
            await query('UPDATE landing_pages SET config = $1 WHERE id = $2', [JSON.stringify(config), id])

            // Also create legacy landing_page_forms record for the submit endpoint
            const existingLpForm = await queryOne('SELECT id FROM landing_page_forms WHERE landing_page_id = $1', [id])
            const lpFormFields = (config.formFields || []).map((f: any) => {
              const fieldId = f.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
              return { id: fieldId, name: fieldId, label: f.label, type: f.type, required: f.required }
            })
            const lpFormSettings = {
              successMessage: 'Thank you! We\'ll be in touch.',
              ...(config.leadMagnet?.downloadUrl ? { redirectUrl: config.leadMagnet.downloadUrl } : {}),
            }
            if (existingLpForm) {
              await query(
                'UPDATE landing_page_forms SET fields = $1, success_message = $2, redirect_url = $3, updated_at = $4 WHERE id = $5',
                [JSON.stringify(lpFormFields), lpFormSettings.successMessage, lpFormSettings.redirectUrl || null, new Date(), existingLpForm.id]
              )
            } else {
              await query(
                `INSERT INTO landing_page_forms (id, landing_page_id, fields, success_message, redirect_url, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $6)`,
                [crypto.randomUUID(), id, JSON.stringify(lpFormFields), lpFormSettings.successMessage, lpFormSettings.redirectUrl || null, new Date()]
              )
            }
          }

          if (config.simpleLayout) {
            // Simple centered layout
            const heroSection = config.generatedSections?.find((s: any) => s.type === 'hero')
            html = assembleSimplePage({
              style,
              pageTitle: page.title,
              headline: heroSection?.headline || page.title,
              subtitle: heroSection?.subtitle || '',
              bullets: heroSection?.bullets || [],
              ctaText: heroSection?.ctaText || 'Get Started',
              formFields: config.formFields || [],
              formAction: v2FormAction,
              slug: page.slug,
              businessName: config.businessContext?.businessName,
              metaDescription: config.metaDescription,
              productId: config.productId || null,
            })
          } else {
            html = assemblePage({
              sections: config.generatedSections,
              style,
              pageTitle: page.title,
              metaDescription: config.metaDescription,
              formFields: config.formFields || [],
              formAction: v2FormAction,
              slug: page.slug,
              businessName: config.businessContext?.businessName,
              bookingPageSlug: config.bookingPageSlug || null,
              productId: config.productId || null,
              pageType: config.pageType || null,
              heroImageUrl: config.heroImageUrl || null,
              thankYouHeadline: config.thankYouHeadline || null,
              thankYouMessage: config.thankYouMessage || null,
            })
          }
        }
      } catch (e) {
        console.error('[pages.publish] Wizard v2 rendering failed:', e)
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
    if (!html && page.published_html) {
      html = page.published_html
      // Ensure form handler points to correct URL
      if (!html.includes(formAction)) {
        const formScript = `<script>
(function(){document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){e.preventDefault();var d={};new FormData(f).forEach(function(v,k){d[k]=v});var b=f.querySelector('[type="submit"]');if(b){b.disabled=true;b.textContent='Sending...';}fetch('${formAction}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:d})}).then(function(r){return r.json()}).then(function(r){if(r.ok){if(r.redirectUrl){window.location.href=r.redirectUrl}else{f.innerHTML='<div style="text-align:center;padding:24px"><h3>Thank you!</h3><p>'+(r.message||"We will be in touch.")+'</p></div>'}}}).catch(function(){if(b){b.disabled=false;b.textContent='Try Again'}})})})})();
</script>`
        html = html.replace('</body>', formScript + '\n</body>')
      }
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

    return NextResponse.json({ ok: true, data: { status: 'published' } })
  } catch (error) {
    console.error('[pages.publish]', error)
    return NextResponse.json({ ok: false, error: 'Failed to publish' }, { status: 500 })
  }
}
