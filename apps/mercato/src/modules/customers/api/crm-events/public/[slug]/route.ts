
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { TEMPLATE_CSS } from '@/modules/courses/api/public/template-css'
import { TEMPLATE_CSS_MINIMAL } from '@/modules/courses/api/public/template-css-minimal'
import { TEMPLATE_CSS_DARK } from '@/modules/courses/api/public/template-css-dark'


export const metadata = { GET: { requireAuth: false } }

function e(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const event = await knex('events').where('slug', slug).where('status', 'published').whereNull('deleted_at').first()
    if (!event) return new NextResponse('<html><body style="font-family:Inter,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;color:#64748b"><h1>Event not found</h1></body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } })

    const profile = await knex('business_profiles').where('organization_id', event.organization_id).first()
    const biz = profile?.business_name || ''
    const baseUrl = process.env.APP_URL || 'http://localhost:3000'

    const lc = event.landing_copy ? (typeof event.landing_copy === 'string' ? JSON.parse(event.landing_copy) : event.landing_copy) : null
    const headline = lc?.headline || event.title
    const sub = lc?.subheadline || event.description || ''
    const bullets = lc?.valueBullets || []
    const highlights = lc?.highlights || []
    const faq = lc?.faq || []
    const whoFor = lc?.whoIsThisFor || []
    const cta = lc?.ctaText || (event.is_free ? 'Register Free' : 'Get Your Ticket')

    const eventDate = new Date(event.start_time).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    const eventTime = new Date(event.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    const endTime = new Date(event.end_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    const location = event.event_type === 'virtual' ? 'Virtual Event' : (event.location_name || 'TBD')
    const isFree = event.is_free
    const price = isFree ? 'Free' : `$${Number(event.price).toFixed(2)}`
    const spotsLeft = event.capacity ? Math.max(0, event.capacity - (event.attendee_count || 0)) : null
    const deadlinePassed = event.registration_deadline && new Date(event.registration_deadline) < new Date()
    const isSoldOut = (event.capacity && (event.attendee_count || 0) >= event.capacity) || deadlinePassed
    const terms = event.terms_text || ''
    const fields = typeof event.registration_fields === 'string' ? JSON.parse(event.registration_fields) : (event.registration_fields || [])

    // Select CSS theme
    const style = event.landing_style || 'warm'
    const cssMap: Record<string, string> = { warm: TEMPLATE_CSS, minimal: TEMPLATE_CSS_MINIMAL, dark: TEMPLATE_CSS_DARK }
    const fontMap: Record<string, string> = {
      warm: 'https://fonts.googleapis.com/css2?family=Nunito:wght@300;400;500;600;700;800&display=swap',
      minimal: 'https://fonts.googleapis.com/css2?family=Literata:wght@400;500;600;700&family=Manrope:wght@300;400;500;600;700;800&display=swap',
      dark: 'https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap',
    }

    // Render custom registration fields
    function renderField(f: any): string {
      const req = f.required ? 'required' : ''
      const name = `field_${f.id}`
      if (f.type === 'repeating_group') return '' // handled in JS
      switch (f.type) {
        case 'text': return `<div class="field"><label>${e(f.label)}</label><input type="text" name="${name}" ${req} /></div>`
        case 'email': return `<div class="field"><label>${e(f.label)}</label><input type="email" name="${name}" ${req} /></div>`
        case 'phone': return `<div class="field"><label>${e(f.label)}</label><input type="tel" name="${name}" ${req} /></div>`
        case 'number': return `<div class="field"><label>${e(f.label)}</label><input type="number" name="${name}" min="${f.min || 1}" max="${f.max || 100}" value="1" ${req} ${f.isQuantityField ? 'data-quantity-field="true" onchange="updateQuantityFields(this)"' : ''} /></div>`
        case 'textarea': return `<div class="field"><label>${e(f.label)}</label><textarea name="${name}" rows="3" ${req}></textarea></div>`
        case 'select': return `<div class="field"><label>${e(f.label)}</label><select name="${name}" ${req}><option value="">Select...</option>${(f.options || []).map((o: string) => `<option value="${e(o)}">${e(o)}</option>`).join('')}</select></div>`
        case 'radio': return `<div class="field"><label>${e(f.label)}</label><div class="options">${(f.options || []).map((o: string) => `<label class="check-label"><input type="radio" name="${name}" value="${e(o)}" ${req} /> ${e(o)}</label>`).join('')}</div></div>`
        default: return `<div class="field"><label>${e(f.label)}</label><input type="text" name="${name}" ${req} /></div>`
      }
    }

    // Find repeating groups and their quantity fields
    const repeatingGroups = fields.filter((f: any) => f.type === 'repeating_group')
    const fieldsHtml = fields.filter((f: any) => f.type !== 'repeating_group').map(renderField).join('\n')

    // Repeating group template (rendered via JS based on quantity)
    let repeatingHtml = ''
    let repeatingJs = ''
    for (const rg of repeatingGroups) {
      repeatingHtml += `<div id="rg_${rg.id}" class="repeating-group" style="display:none"><label style="font-weight:600;font-size:14px;margin-bottom:8px;display:block">${e(rg.label)}</label><div id="rg_${rg.id}_items"></div></div>`
      const subFieldsTemplate = (rg.fields || []).map((sf: any) => {
        if (sf.type === 'select') return `<div class="field"><label>${e(sf.label)}</label><select name="rg_${rg.id}_IDX_${sf.id}"><option value="">Select...</option>${(sf.options || []).map((o: string) => `<option value="${e(o)}">${e(o)}</option>`).join('')}</select></div>`
        return `<div class="field"><label>${e(sf.label)}</label><input type="text" name="rg_${rg.id}_IDX_${sf.id}" ${sf.required ? 'required' : ''} /></div>`
      }).join('')
      repeatingJs += `
function updateRG_${rg.id}(qty) {
  var container = document.getElementById('rg_${rg.id}_items');
  var wrapper = document.getElementById('rg_${rg.id}');
  container.innerHTML = '';
  wrapper.style.display = qty > 0 ? 'block' : 'none';
  for (var i = 0; i < qty; i++) {
    var div = document.createElement('div');
    div.className = 'guest-group';
    div.innerHTML = '<p style="font-weight:600;font-size:13px;margin-bottom:6px;color:var(--text-secondary)">${e(rg.label)} ' + (i+1) + '</p>' + '${subFieldsTemplate}'.replace(/IDX/g, i);
    container.appendChild(div);
  }
}\n`
    }

    // Quantity field change handler JS
    let quantityJs = ''
    for (const rg of repeatingGroups) {
      if (rg.dependsOn) {
        quantityJs += `if (el.name === 'field_${rg.dependsOn}') updateRG_${rg.id}(parseInt(el.value) || 0);\n`
      }
    }

    const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${e(event.title)} — ${e(biz || 'Event')}</title>
<meta name="description" content="${e(sub)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${fontMap[style] || fontMap.warm}" rel="stylesheet">
<style>
${cssMap[style] || cssMap.warm}
.guest-group { border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 12px; }
.event-meta { display: flex; flex-wrap: wrap; gap: 16px; margin: 20px 0 28px; font-size: 14px; color: var(--text-secondary); }
.event-meta-item { display: flex; align-items: center; gap: 6px; }
.event-meta-item svg { width: 16px; height: 16px; stroke: currentColor; stroke-width: 1.5; fill: none; flex-shrink: 0; }
.spots-badge { display: inline-block; padding: 4px 12px; border-radius: var(--radius-pill); font-size: 12px; font-weight: 600; }
.spots-available { background: rgba(34,197,94,0.1); color: #16a34a; }
.spots-limited { background: rgba(245,158,11,0.1); color: #d97706; }
.spots-soldout { background: rgba(239,68,68,0.1); color: #dc2626; }
</style></head><body>

<nav class="nav"><div class="container"><div class="nav-inner">
  <a href="#" class="nav-logo">${e(biz || event.title)}</a>
  <ul class="nav-links">
    <li><a href="#details">Details</a></li>
    ${faq.length > 0 ? '<li><a href="#faq">FAQ</a></li>' : ''}
    <li><a href="#register">Register</a></li>
  </ul>
  <a href="#register" class="nav-cta">${e(cta)}</a>
</div></div></nav>

<section class="hero"><div class="container">
  <div style="text-align:center;max-width:1100px;margin:0 auto" class="reveal">
    <span class="tag tag-tomato" style="margin-bottom:16px">${e(event.event_type === 'virtual' ? 'Virtual Event' : event.event_type === 'hybrid' ? 'Hybrid Event' : 'In-Person Event')}</span>
    <h1>${e(headline)}</h1>
    <p class="hero-desc" style="margin:0 auto 20px;max-width:750px">${e(sub)}</p>
    <div class="event-meta" style="justify-content:center">
      <span class="event-meta-item"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${eventDate}</span>
      <span class="event-meta-item"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${eventTime} — ${endTime}</span>
      <span class="event-meta-item"><svg viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>${e(location)}</span>
    </div>
    <div class="hero-buttons" style="justify-content:center">
      <a href="#register" class="btn btn-tomato">${e(cta)}<svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></a>
    </div>
    ${spotsLeft !== null ? `<div style="margin-top:16px"><span class="spots-badge ${isSoldOut ? 'spots-soldout' : spotsLeft <= 10 ? 'spots-limited' : 'spots-available'}">${isSoldOut ? 'Sold Out' : `${spotsLeft} spot${spotsLeft !== 1 ? 's' : ''} remaining`}</span></div>` : ''}
  </div>
</div></section>

${bullets.length > 0 ? `<section class="learn" id="details"><div class="container">
  <div class="learn-header reveal"><h2>What to expect.</h2></div>
  <div class="learn-grid" style="grid-template-columns:repeat(${bullets.length % 3 === 0 ? 3 : 2},1fr)">
    ${bullets.map((b: any, i: number) => {
      const isObj = typeof b === 'object' && b.title
      return isObj
        ? `<div class="learn-card reveal" style="transition-delay:${i*0.05}s"><h3>${e(b.title)}</h3><p>${e(b.description || '')}</p></div>`
        : `<div class="learn-card reveal" style="transition-delay:${i*0.05}s"><p>${e(String(b))}</p></div>`
    }).join('')}
  </div>
</div></section>` : ''}

${highlights.length > 0 ? `<section class="highlights"><div class="container">
  <div class="highlights-header reveal"><h2>Why attend.</h2></div>
  <div class="highlights-grid" style="grid-template-columns:repeat(${highlights.length % 3 === 0 ? 3 : 2},1fr)">
    ${highlights.map((h: any, i: number) => `<div class="highlight-card reveal" style="transition-delay:${i*0.05}s"><div class="highlight-body"><h3>${e(h.title)}</h3><p>${e(h.description)}</p></div></div>`).join('')}
  </div>
</div></section>` : ''}

${whoFor.length > 0 ? `<section class="who-section"><div class="container">
  <div class="who-header reveal"><h2>Who should attend?</h2></div>
  <div class="who-grid" style="grid-template-columns:repeat(${whoFor.length % 3 === 0 ? 3 : 2},1fr)">
    ${whoFor.map((w: any, i: number) => {
      const isObj = typeof w === 'object' && w.title
      const icons = ['<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>','<svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>','<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>']
      return isObj
        ? `<div class="who-card reveal" style="transition-delay:${i*0.05}s"><div class="who-icon">${icons[i%3]}</div><div class="who-title">${e(w.title)}</div><div class="who-desc">${e(w.description || '')}</div></div>`
        : `<div class="who-card reveal" style="transition-delay:${i*0.05}s"><div class="who-desc">${e(String(w))}</div></div>`
    }).join('')}
  </div>
</div></section>` : ''}

${faq.length > 0 ? `<section class="faq" id="faq"><div class="container">
  <div class="faq-header reveal"><h2>Questions?</h2></div>
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

<section class="pricing-section" id="register"><div class="container">
  <div class="pricing-header reveal"><h2>${isSoldOut ? 'Registration Closed' : 'Register Now'}</h2>
    <p>${isFree ? 'Free — no credit card required' : `Reserve your spot for ${price}`}</p>
  </div>
  ${isSoldOut ? `<div class="enroll-card reveal" style="text-align:center;padding:40px"><p style="font-size:18px;font-weight:600;margin-bottom:8px">${deadlinePassed ? 'Registration has closed' : 'This event is sold out'}</p><p style="color:var(--text-secondary)">${deadlinePassed ? 'The registration deadline has passed.' : 'Check back for future events.'}</p></div>` : `
  <div class="enroll-card${!isFree ? ' featured' : ''} reveal">
    <div class="pricing-price">${price}</div>
    <div class="pricing-desc">${eventDate} · ${eventTime}</div>
    <div class="error" id="err"></div>
    <form onsubmit="registerSubmit(event)" id="regForm" class="enroll-form">
      <div class="field"><label>Full Name *</label><input type="text" name="name" required placeholder="Jane Smith"></div>
      <div class="field"><label>Email Address *</label><input type="email" name="email" required placeholder="jane@example.com"></div>
      ${fieldsHtml}
      ${repeatingHtml}
      ${terms ? `<label class="terms-check"><input type="checkbox" name="acceptedTerms" value="yes" required checked /><span>I agree to the <a href="#" onclick="document.getElementById('termsBox').style.display=document.getElementById('termsBox').style.display==='none'?'block':'none';return false" style="color:var(--tomato);font-weight:600">terms and conditions</a></span></label><div id="termsBox" class="terms-box">${e(terms)}</div>` : ''}
      <button type="submit" class="enroll-btn" id="regBtn">${e(cta)}</button>
    </form>
    <div class="success" id="success" style="display:none"><h3>You're registered!</h3><p>Check your email for confirmation details.</p></div>
    <div class="guarantee"><svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Secure registration · Instant confirmation</div>
  </div>`}
</div></section>

<footer class="footer"><div class="container">
  <div class="footer-bottom">&copy; ${new Date().getFullYear()} ${biz ? e(biz) : 'All rights reserved'}.</div>
</div></footer>

<script>
var observer=new IntersectionObserver(function(entries){entries.forEach(function(entry){if(entry.isIntersecting){entry.target.classList.add('visible');observer.unobserve(entry.target)}})},{threshold:0.1,rootMargin:'0px 0px -30px 0px'});
document.querySelectorAll('.reveal').forEach(function(el){observer.observe(el)});
function toggleFaq(button){var item=button.parentElement;var wasActive=item.classList.contains('active');document.querySelectorAll('.faq-item').forEach(function(f){f.classList.remove('active')});if(!wasActive)item.classList.add('active')}
function updateQuantityFields(el){${quantityJs}}
${repeatingJs}
async function registerSubmit(ev){
  ev.preventDefault();
  var btn=document.getElementById('regBtn'),err=document.getElementById('err');
  err.style.display='none';btn.disabled=true;btn.textContent='Registering...';
  var fd=new FormData(ev.target);
  var name=fd.get('name'),email=fd.get('email'),terms=fd.get('acceptedTerms');
  var registrationData={};var guestDetails=[];
  fd.forEach(function(val,key){
    if(key.startsWith('field_'))registrationData[key]=val;
    if(key.startsWith('rg_')){
      var parts=key.split('_');var rgId=parts[1];var idx=parseInt(parts[2]);var fieldId=parts[3];
      if(!guestDetails[idx])guestDetails[idx]={preferences:{}};
      if(fieldId==='guest_name'||fieldId.includes('name'))guestDetails[idx].name=val;
      else guestDetails[idx].preferences[fieldId]=val;
    }
  });
  var ticketQty=1;
  document.querySelectorAll('[data-quantity-field]').forEach(function(el){ticketQty=parseInt(el.value)||1});
  try{
    var r=await fetch('${baseUrl}/api/crm-events/public/${event.slug}/register',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:name,email:email,ticketQuantity:ticketQty,guestDetails:guestDetails.length?guestDetails:undefined,registrationData:registrationData,acceptedTerms:terms||undefined})
    });
    var d=await r.json();
    if(d.ok){document.getElementById('regForm').style.display='none';document.getElementById('success').style.display='block'}
    else if(d.requiresPayment){
      btn.textContent='Connecting to payment...';
      var pr=await fetch('${baseUrl}/api/crm-events/public/${event.slug}/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,email:email,ticketQuantity:ticketQty,guestDetails:guestDetails.length?guestDetails:undefined,registrationData:registrationData,acceptedTerms:terms||undefined})});
      var pd=await pr.json();
      if(pd.ok&&pd.data&&pd.data.url){btn.textContent='Redirecting to checkout...';window.location.href=pd.data.url}
      else{err.textContent=pd.error||'Checkout failed';err.style.display='block';btn.disabled=false;btn.textContent='${e(cta)}'}
    }
    else{err.textContent=d.error||'Registration failed';err.style.display='block';btn.disabled=false;btn.textContent='${e(cta)}'}
  }catch{err.textContent='Something went wrong.';err.style.display='block';btn.disabled=false;btn.textContent='${e(cta)}'}
}
</script>
</body></html>`

    return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  } catch (error) {
    console.error('[crm-events.public]', error)
    return new NextResponse('Something went wrong', { status: 500 })
  }
}
