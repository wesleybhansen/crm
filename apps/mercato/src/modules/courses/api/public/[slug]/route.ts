import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { TEMPLATE_CSS } from '../template-css'
import { TEMPLATE_CSS_MINIMAL } from '../template-css-minimal'
import { TEMPLATE_CSS_DARK } from '../template-css-dark'

export const metadata = { GET: { requireAuth: false } }

function e(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

const TAG_CLASSES = ['tag-tomato', 'tag-orange', 'tag-blue', 'tag-green', 'tag-purple', 'tag-yellow']

export async function GET(req: Request, ctx: any) {
  const slug = ctx?.params?.slug
  if (!slug) return new NextResponse('Not found', { status: 404 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const course = await knex('courses').where('slug', slug).where('is_published', true).whereNull('deleted_at').first()
    if (!course) return new NextResponse('Course not found', { status: 404 })

    const modules = await knex('course_modules').where('course_id', course.id).orderBy('sort_order')
    for (const mod of modules) {
      mod.lessons = await knex('course_lessons').where('module_id', mod.id).orderBy('sort_order')
        .select('id', 'title', 'content_type', 'duration_minutes', 'is_free_preview', 'description')
    }
    const [{ count }] = await knex('course_enrollments').where('course_id', course.id).where('status', 'active').count()
    const totalLessons = modules.reduce((s: number, m: any) => s + (m.lessons?.length || 0), 0)
    const totalMin = modules.reduce((s: number, m: any) => s + m.lessons.reduce((ls: number, l: any) => ls + (l.duration_minutes || 0), 0), 0)
    const profile = await knex('business_profiles').where('organization_id', course.organization_id).first()
    const baseUrl = process.env.APP_URL || 'http://localhost:3000'

    const lc = course.landing_copy ? (typeof course.landing_copy === 'string' ? JSON.parse(course.landing_copy) : course.landing_copy) : null
    const headline = lc?.headline || course.title
    const sub = lc?.subheadline || course.description || ''
    const bullets = lc?.valueBullets || []
    const highlights = lc?.highlights || []
    const faq = lc?.faq || []
    const whoFor = lc?.whoIsThisFor || []
    const cta = lc?.ctaText || (course.is_free ? 'Start Learning Free' : 'Enroll Now')
    const social = lc?.socialProofLine || ''
    const isFree = course.is_free
    const price = isFree ? 'Free' : `$${Number(course.price).toFixed(2)}`
    const terms = course.terms_text || ''
    const hrs = totalMin >= 60 ? `${(totalMin / 60).toFixed(1)} hours` : `${totalMin || totalLessons * 10} min`
    const enrolled = Number(count)
    const biz = profile?.business_name || ''
    // No instructor bio field exists yet. The business description is written
    // for the owner ("You provide...") and read as a wrong-voice bio on the
    // public page, so the instructor block shows the name only.
    const style = course.landing_style || 'warm'

    // Select CSS and font based on landing style
    const styleConfig: Record<string, { css: string; font: string; fontUrl: string }> = {
      warm: {
        css: TEMPLATE_CSS,
        font: 'Nunito',
        fontUrl: 'https://fonts.googleapis.com/css2?family=Nunito:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400&display=swap',
      },
      minimal: {
        css: TEMPLATE_CSS_MINIMAL,
        font: 'Manrope',
        fontUrl: 'https://fonts.googleapis.com/css2?family=Literata:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Manrope:wght@300;400;500;600;700;800&display=swap',
      },
      dark: {
        css: TEMPLATE_CSS_DARK,
        font: 'Instrument Sans',
        fontUrl: 'https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Newsreader:ital,wght@0,400;0,500;0,600;1,400&display=swap',
      },
    }
    const sc = styleConfig[style] || styleConfig.warm

    const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${e(course.title)}</title>
<meta name="description" content="${e(sub)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${sc.fontUrl}" rel="stylesheet">
<style>
${sc.css}
</style></head><body>

<nav class="nav"><div class="container"><div class="nav-inner">
  <a href="#" class="nav-logo">${e(biz || course.title)}</a>
  <ul class="nav-links">
    <li><a href="#learn">Curriculum</a></li>
    ${biz ? '<li><a href="#instructor">Instructor</a></li>' : ''}
    <li><a href="#pricing">Pricing</a></li>
    ${faq.length > 0 ? '<li><a href="#faq">FAQ</a></li>' : ''}
  </ul>
  <a href="#pricing" class="nav-cta">${e(cta)}</a>
  <button class="nav-mobile-toggle" onclick="toggleMobileNav()" aria-label="Menu">
    <svg viewBox="0 0 24 24" id="menuIcon"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
  </button>
</div></div></nav>

<div class="mobile-nav" id="mobileNav">
  <a href="#learn" onclick="closeMobileNav()">Curriculum</a>
  ${biz ? '<a href="#instructor" onclick="closeMobileNav()">Instructor</a>' : ''}
  <a href="#pricing" onclick="closeMobileNav()">Pricing</a>
  ${faq.length > 0 ? '<a href="#faq" onclick="closeMobileNav()">FAQ</a>' : ''}
  <a href="#pricing" onclick="closeMobileNav()">${e(cta)}</a>
</div>

<section class="hero"><div class="container">
  <div style="text-align:center;max-width:1100px;margin:0 auto" class="reveal">
    <span class="tag tag-tomato" style="margin-bottom:16px">Online Course</span>
    <h1>${e(headline)}</h1>
    <p class="hero-desc" style="margin:0 auto 28px;max-width:750px">${e(sub)}</p>
    <div class="hero-buttons" style="justify-content:center">
      <a href="#pricing" class="btn btn-tomato">${e(cta)}<svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></a>
      <a href="#learn" class="btn btn-outline">View Curriculum</a>
    </div>
    ${enrolled > 0 ? `<div class="hero-social-proof" style="justify-content:center;margin-top:24px">
      <span class="hero-social-text">Join <strong>${enrolled.toLocaleString()}+</strong> students already enrolled</span>
    </div>` : ''}
  </div>
</div></section>

${bullets.length > 0 ? `<section class="learn" id="learn"><div class="container">
  <div class="learn-header reveal"><h2>What you'll learn.</h2><p>The skills and knowledge you'll walk away with.</p></div>
  <div class="learn-grid" style="grid-template-columns:repeat(${bullets.length % 3 === 0 ? 3 : 2},1fr)">
    ${bullets.map((b: any, i: number) => {
      const isObj = typeof b === 'object' && b.title
      if (isObj) {
        return `<div class="learn-card reveal" style="transition-delay:${i * 0.05}s"><span class="tag ${TAG_CLASSES[i % TAG_CLASSES.length]}">Outcome ${i + 1}</span><h3>${e(b.title)}</h3><p>${e(b.description || '')}</p></div>`
      }
      return `<div class="learn-card reveal" style="transition-delay:${i * 0.05}s"><span class="tag ${TAG_CLASSES[i % TAG_CLASSES.length]}">Outcome ${i + 1}</span><p>${e(String(b))}</p></div>`
    }).join('')}
  </div>
</div></section>` : ''}

${highlights.length > 0 ? `<section class="highlights"><div class="container">
  <div class="highlights-header reveal"><h2>Everything you need to succeed.</h2></div>
  <div class="highlights-grid" style="grid-template-columns:repeat(${highlights.length % 3 === 0 ? 3 : 2},1fr)">
    ${highlights.map((h: any, i: number) => {
      const colors = ['tomato', 'blue', 'green', 'orange', 'purple']
      const icons = [
        '<svg viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
        '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
        '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
        '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
        '<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
      ]
      return `<div class="highlight-card reveal" style="transition-delay:${i * 0.05}s"><div class="highlight-accent ${colors[i % colors.length]}"></div><div class="highlight-body"><div class="highlight-icon">${icons[i % icons.length]}</div><h3>${e(h.title)}</h3><p>${e(h.description)}</p></div></div>`
    }).join('')}
  </div>
</div></section>` : ''}

<section class="curriculum" id="${bullets.length === 0 ? 'learn' : 'curriculum'}"><div class="container">
  <div class="curriculum-header reveal"><h2>Full curriculum.</h2><p>${modules.length} ${modules.length === 1 ? 'module' : 'modules'} · ${totalLessons} ${totalLessons === 1 ? 'lesson' : 'lessons'} · ${hrs} of content</p></div>
  <div class="curriculum-list">
    ${modules.map((m: any, mi: number) => `<div class="module-item reveal${mi === 0 ? ' active' : ''}">
      <button class="module-header" onclick="toggleModule(this)">
        <div class="module-header-left">
          <span class="module-chevron"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></span>
          <span class="module-title">${/^module\s*\d/i.test(m.title) ? e(m.title) : `Module ${mi + 1}: ${e(m.title)}`}</span>
        </div>
        <span class="module-meta">${m.lessons?.length || 0} lessons</span>
      </button>
      <div class="module-lessons"><div class="module-lessons-inner">
        ${(m.lessons || []).map((l: any) => `<div class="lesson-row"><div class="lesson-check"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>${e(l.title)}${l.file_url ? '<svg viewBox="0 0 24 24" style="width:16px;height:16px;margin-left:auto;opacity:0.4;flex-shrink:0"><path d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>' : ''}${l.is_free_preview ? '<span class="free-tag">Free Preview</span>' : ''}</div>`).join('')}
      </div></div>
    </div>`).join('')}
  </div>
</div></section>

${whoFor.length > 0 ? `<section class="who-section"><div class="container">
  <div class="who-header reveal"><h2>Who is this for?</h2></div>
  <div class="who-grid" style="grid-template-columns:repeat(${whoFor.length % 3 === 0 ? 3 : 2},1fr)">
    ${(() => {
      const whoIcons = [
        '<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
        '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
        '<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
      ]
      return whoFor.map((w: any, i: number) => {
        const isObj = typeof w === 'object' && w.title
        const icon = whoIcons[i % whoIcons.length]
        if (isObj) {
          return `<div class="who-card reveal" style="transition-delay:${i * 0.05}s"><div class="who-icon">${icon}</div><div class="who-title">${e(w.title)}</div><div class="who-desc">${e(w.description || '')}</div></div>`
        }
        return `<div class="who-card reveal" style="transition-delay:${i * 0.05}s"><div class="who-icon">${icon}</div><div class="who-desc">${e(String(w))}</div></div>`
      }).join('')
    })()}
  </div>
</div></section>` : ''}

${biz ? `<section class="instructor" id="instructor"><div class="container">
  <div class="instructor-grid reveal">
    <div class="instructor-avatar">${e(biz[0].toUpperCase())}</div>
    <div>
      <div class="instructor-name">${e(biz)}</div>
      <div class="instructor-title">Your Instructor</div>
    </div>
  </div>
</div></section>` : ''}

${faq.length > 0 ? `<section class="faq" id="faq"><div class="container">
  <div class="faq-header reveal"><h2>Frequently asked questions.</h2></div>
  <div class="faq-list">
    ${faq.map((f: any) => `<div class="faq-item reveal">
      <button class="faq-question" onclick="toggleFaq(this)">
        <span class="faq-chevron"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></span>
        <span>${e(f.question)}</span>
      </button>
      <div class="faq-answer"><div class="faq-answer-inner"><p>${e(f.answer)}</p></div></div>
    </div>`).join('')}
  </div>
</div></section>` : ''}

<section class="pricing-section" id="pricing"><div class="container">
  <div class="pricing-header reveal"><h2>Ready to start?</h2><p>${isFree ? 'Enroll for free and start learning today.' : `Invest in yourself for just ${price}.`}</p></div>
  <div class="enroll-card${!isFree ? ' featured' : ''} reveal">
    <div class="pricing-price">${price}</div>
    <div class="pricing-desc">${isFree ? 'No credit card required' : 'One-time payment · Lifetime access'}</div>
    <ul class="pricing-features">
      ${totalLessons > 0 ? `<li><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>${totalLessons} ${totalLessons === 1 ? 'lesson' : 'lessons'} across ${modules.length} ${modules.length === 1 ? 'module' : 'modules'}</li>
      <li><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>${hrs} of content</li>` : ''}
      <li><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>Lifetime access to all materials</li>
      <li><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>Progress tracking & completion</li>
    </ul>
    <div class="error" id="err"></div>
    <form onsubmit="enrollSubmit(event)" id="enrollForm" class="enroll-form">
      <div class="field"><label>Full Name</label><input type="text" name="name" required placeholder="Jane Smith"></div>
      <div class="field"><label>Email Address</label><input type="email" name="email" required placeholder="jane@example.com"></div>
      ${terms ? `<label class="terms-check"><input type="checkbox" name="acceptedTerms" value="yes" required checked /><span>I agree to the <a href="#" onclick="document.getElementById('termsBox').style.display=document.getElementById('termsBox').style.display==='none'?'block':'none';return false" style="color:var(--tomato);font-weight:600">terms and conditions</a></span></label><div id="termsBox" class="terms-box">${e(terms)}</div>` : ''}
      <button type="submit" class="enroll-btn" id="enrollBtn">${e(cta)}</button>
    </form>
    <div class="success" id="success" style="display:none"><h3>You're enrolled!</h3><p>Check your email for your access link.</p></div>
    <div class="guarantee"><svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Secure enrollment · Instant access</div>
  </div>
</div></section>

<footer class="footer"><div class="container">
  <div class="footer-bottom">&copy; ${new Date().getFullYear()} ${biz ? e(biz) : 'All rights reserved'}.</div>
</div></footer>

<script>
var observer=new IntersectionObserver(function(entries){entries.forEach(function(entry){if(entry.isIntersecting){entry.target.classList.add('visible');observer.unobserve(entry.target)}})},{threshold:0.1,rootMargin:'0px 0px -30px 0px'});
document.querySelectorAll('.reveal').forEach(function(el){observer.observe(el)});
function toggleModule(button){var item=button.parentElement;var wasActive=item.classList.contains('active');document.querySelectorAll('.module-item').forEach(function(m){m.classList.remove('active')});if(!wasActive)item.classList.add('active')}
function toggleFaq(button){var item=button.parentElement;var wasActive=item.classList.contains('active');document.querySelectorAll('.faq-item').forEach(function(f){f.classList.remove('active')});if(!wasActive)item.classList.add('active')}
var mobileNavOpen=false;function toggleMobileNav(){mobileNavOpen=!mobileNavOpen;var nav=document.getElementById('mobileNav');if(mobileNavOpen){nav.classList.add('open')}else{nav.classList.remove('open')}}function closeMobileNav(){mobileNavOpen=false;document.getElementById('mobileNav').classList.remove('open')}
async function enrollSubmit(ev){ev.preventDefault();var btn=document.getElementById('enrollBtn'),err=document.getElementById('err');err.style.display='none';btn.disabled=true;btn.textContent=${isFree} ? 'Enrolling...' : 'Connecting to payment...';var fd=new FormData(ev.target),name=fd.get('name'),email=fd.get('email'),terms=fd.get('acceptedTerms');if(${terms ? 'true' : 'false'}){var tc=document.querySelector('input[name="acceptedTerms"]');if(tc&&!tc.checked){err.textContent='You must accept the terms.';err.style.display='block';btn.disabled=false;btn.textContent='${e(cta)}';return}}try{if(${isFree}){var r=await fetch('${baseUrl}/api/courses/enrollments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({courseId:'${course.id}',studentName:name,studentEmail:email,acceptedTerms:terms||undefined})});var d=await r.json();if(d.ok){document.getElementById('enrollForm').style.display='none';document.getElementById('success').style.display='block'}else{err.textContent=d.error||'Failed';err.style.display='block';btn.disabled=false;btn.textContent='${e(cta)}'}}else{var r=await fetch('${baseUrl}/api/courses/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({courseId:'${course.id}',studentName:name,studentEmail:email,acceptedTerms:terms||undefined})});var d=await r.json();if(d.ok&&d.data&&d.data.url){btn.textContent='Redirecting to checkout...';window.location.href=d.data.url}else if(d.alreadyEnrolled){document.getElementById('enrollForm').style.display='none';document.getElementById('success').innerHTML='<h3>Already Enrolled!</h3><p><a href="${baseUrl}/course/${course.slug}/learn" style="color:var(--tomato);font-weight:600">Go to your course &rarr;</a></p>';document.getElementById('success').style.display='block'}else{err.textContent=d.error||'Failed';err.style.display='block';btn.disabled=false;btn.textContent='${e(cta)}'}}}catch{err.textContent='Something went wrong.';err.style.display='block';btn.disabled=false;btn.textContent='${e(cta)}'}}
</script>
</body></html>`

    return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  } catch (error) {
    console.error('[courses.public]', error)
    return new NextResponse('Something went wrong', { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Courses (Public)', summary: 'Public course landing page',
  methods: { GET: { summary: 'Render public course page', tags: ['Courses (Public)'] } },
}
