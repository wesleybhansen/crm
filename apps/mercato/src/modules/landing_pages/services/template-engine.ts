/**
 * @deprecated Legacy template engine — renders pages from HTML template files.
 * New pages (wizardVersion 2) use the section-renderer + page-assembler at
 * src/lib/landing-page-wizard/ instead. Kept for backward compatibility
 * with pages created before the wizard redesign.
 */
import * as fs from 'fs'
import * as path from 'path'

export interface TemplateInfo {
  id: string
  name: string
  category: string
  style: string
  hasForm: boolean
}

export interface TemplateConfig {
  // Branding
  businessName?: string
  logoUrl?: string
  // Content
  headline?: string
  subheadline?: string
  bodyText?: string
  ctaText?: string
  ctaUrl?: string
  // Design (injected as CSS variables)
  primaryColor?: string
  accentColor?: string
  backgroundColor?: string
  textColor?: string
  fontFamily?: string
  borderRadius?: string
  // Form
  formAction?: string
  formFields?: Array<{
    name: string
    type: string
    label: string
    required: boolean
    placeholder?: string
  }>
  // Meta
  pageTitle?: string
  metaDescription?: string
}

import { TEMPLATES_DIR } from './paths'

export class TemplateEngine {
  private templatesDir: string

  constructor(templatesDir?: string) {
    this.templatesDir = templatesDir || TEMPLATES_DIR
  }

  listTemplates(): TemplateInfo[] {
    if (!fs.existsSync(this.templatesDir)) {
      return []
    }

    const dirs = fs.readdirSync(this.templatesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)

    return dirs.map((dir) => {
      const parts = dir.split('-')
      // Template naming: category-style (e.g., lead-magnet-bold, saas-vercel)
      // Some have 2-word categories: lead-magnet, info-product, physical-product
      let category: string
      let style: string

      const twoWordCategories = ['lead-magnet', 'info-product', 'physical-product', 'thank-you', 'case-study']
      const prefix = parts.slice(0, 2).join('-')
      if (twoWordCategories.includes(prefix)) {
        category = prefix
        style = parts.slice(2).join('-') || 'default'
      } else {
        category = parts[0]
        style = parts.slice(1).join('-') || 'default'
      }

      // Check if template has a form
      const htmlPath = path.join(this.templatesDir, dir, 'index.html')
      let hasForm = false
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf-8')
        hasForm = /<form[\s>]/i.test(html) || /<input[^>]*type=["']email/i.test(html)
      }

      return {
        id: dir,
        name: this.formatName(dir),
        category,
        style,
        hasForm,
      }
    })
  }

  getTemplatesByCategory(): Record<string, TemplateInfo[]> {
    const templates = this.listTemplates()
    const grouped: Record<string, TemplateInfo[]> = {}
    for (const t of templates) {
      if (!grouped[t.category]) grouped[t.category] = []
      grouped[t.category].push(t)
    }
    return grouped
  }

  renderTemplate(templateId: string, config: TemplateConfig): string {
    const htmlPath = path.join(this.templatesDir, templateId, 'index.html')
    if (!fs.existsSync(htmlPath)) {
      throw new Error(`Template not found: ${templateId}`)
    }

    let html = fs.readFileSync(htmlPath, 'utf-8')

    // Inject page title
    if (config.pageTitle) {
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${this.escapeHtml(config.pageTitle)}</title>`)
    }

    // Inject meta description
    if (config.metaDescription) {
      if (html.includes('<meta name="description"')) {
        html = html.replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${this.escapeHtml(config.metaDescription)}">`)
      } else {
        html = html.replace('</head>', `<meta name="description" content="${this.escapeHtml(config.metaDescription)}">\n</head>`)
      }
    }

    // Inject CSS variable overrides
    const cssOverrides = this.buildCssOverrides(config)
    if (cssOverrides) {
      html = html.replace('</head>', `<style>\n:root {\n${cssOverrides}\n}\n</style>\n</head>`)
    }

    // Replace text content placeholders
    html = this.replaceTextContent(html, config)

    // Inject form action URL
    if (config.formAction) {
      html = html.replace(/<form([^>]*)>/gi, (match, attrs) => {
        if (attrs.includes('action=')) {
          return match.replace(/action="[^"]*"/, `action="${config.formAction}"`)
        }
        return `<form${attrs} action="${config.formAction}" method="POST">`
      })
    }

    // Inject form submission handler
    html = this.injectFormHandler(html, config)

    return html
  }

  private buildCssOverrides(config: TemplateConfig): string {
    const overrides: string[] = []

    if (config.primaryColor) {
      // Common CSS variable names used across templates
      overrides.push(`  --black: ${config.primaryColor};`)
      overrides.push(`  --accent: ${config.primaryColor};`)
    }
    if (config.accentColor) {
      overrides.push(`  --coral: ${config.accentColor};`)
      overrides.push(`  --blue: ${config.accentColor};`)
      overrides.push(`  --yellow: ${config.accentColor};`)
      overrides.push(`  --sage: ${config.accentColor};`)
      overrides.push(`  --gold: ${config.accentColor};`)
    }
    if (config.backgroundColor) {
      overrides.push(`  --white: ${config.backgroundColor};`)
      overrides.push(`  --bg: ${config.backgroundColor};`)
    }
    if (config.borderRadius) {
      overrides.push(`  --radius: ${config.borderRadius};`)
    }

    return overrides.length > 0 ? overrides.join('\n') : ''
  }

  private replaceTextContent(html: string, config: TemplateConfig): string {
    // Replace nav logo / brand name
    if (config.businessName) {
      html = html.replace(/(<[^>]*class="[^"]*nav-logo[^"]*"[^>]*>)([^<]*)(<\/[^>]+>)/gi,
        `$1${this.escapeHtml(config.businessName)}$3`)
    }

    return html
  }

  private injectFormHandler(html: string, config: TemplateConfig): string {
    if (!config.formAction) return html

    const script = `
<script>
(function() {
  var forms = document.querySelectorAll('form');
  forms.forEach(function(form) {
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      var formData = new FormData(form);
      var data = {};
      formData.forEach(function(value, key) { data[key] = value; });

      fetch('${config.formAction}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: data })
      })
      .then(function(res) { return res.json(); })
      .then(function(result) {
        if (result.ok) {
          var successEl = document.getElementById('form-success');
          if (successEl) {
            successEl.style.display = 'block';
            form.style.display = 'none';
          } else {
            form.innerHTML = '<p style="text-align:center;padding:20px;font-size:18px;">Thank you! We\\'ll be in touch.</p>';
          }
        }
      })
      .catch(function() {
        alert('Something went wrong. Please try again.');
      });
    });
  });
})();
</script>`

    html = html.replace('</body>', `${script}\n</body>`)
    return html
  }

  private formatName(id: string): string {
    return id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }
}
