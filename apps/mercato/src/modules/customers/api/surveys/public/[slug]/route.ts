// ORM-SKIP: complex public-facing route with HTML rendering

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export const metadata = { path: '/surveys/public/[slug]', GET: { requireAuth: false } }

function renderField(field: { id: string; type: string; label: string; required?: boolean; options?: string[] }): string {
  const req = field.required ? 'required' : ''
  const reqStar = field.required ? '<span class="req">*</span>' : ''
  const name = `field_${field.id}`

  switch (field.type) {
    case 'text':
      return `<div class="field"><label>${field.label}${reqStar}</label><input type="text" name="${name}" ${req} /></div>`
    case 'email':
      return `<div class="field"><label>${field.label}${reqStar}</label><input type="email" name="${name}" ${req} /></div>`
    case 'phone':
      return `<div class="field"><label>${field.label}${reqStar}</label><input type="tel" name="${name}" ${req} /></div>`
    case 'number':
      return `<div class="field"><label>${field.label}${reqStar}</label><input type="number" name="${name}" ${req} /></div>`
    case 'date':
      return `<div class="field"><label>${field.label}${reqStar}</label><input type="date" name="${name}" ${req} /></div>`
    case 'textarea':
      return `<div class="field"><label>${field.label}${reqStar}</label><textarea name="${name}" rows="4" ${req}></textarea></div>`
    case 'select':
      const opts = (field.options || []).map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')
      return `<div class="field"><label>${field.label}${reqStar}</label><select name="${name}" ${req}><option value="">Select...</option>${opts}</select></div>`
    case 'multi_select':
      const checks = (field.options || []).map(o =>
        `<label class="check-label"><input type="checkbox" name="${name}" value="${escapeHtml(o)}" /> ${escapeHtml(o)}</label>`
      ).join('')
      return `<div class="field"><label>${field.label}${reqStar}</label><div class="options">${checks}</div></div>`
    case 'radio':
      const radios = (field.options || []).map(o =>
        `<label class="check-label"><input type="radio" name="${name}" value="${escapeHtml(o)}" ${req} /> ${escapeHtml(o)}</label>`
      ).join('')
      return `<div class="field"><label>${field.label}${reqStar}</label><div class="options">${radios}</div></div>`
    case 'checkbox':
      return `<div class="field"><label class="check-label"><input type="checkbox" name="${name}" value="true" ${req} /> ${field.label}${reqStar}</label></div>`
    case 'rating':
      return `<div class="field"><label>${field.label}${reqStar}</label><div class="rating" data-name="${name}">` +
        [1,2,3,4,5].map(i => `<span class="star" data-value="${i}">☆</span>`).join('') +
        `<input type="hidden" name="${name}" value="" ${req} /></div></div>`
    case 'nps':
      const npsButtons = Array.from({length: 11}, (_, i) =>
        `<button type="button" class="nps-btn" data-value="${i}" onclick="selectNps(this, '${name}')">${i}</button>`
      ).join('')
      return `<div class="field"><label>${field.label}${reqStar}</label><div class="nps-row">${npsButtons}</div><input type="hidden" name="${name}" value="" ${req} /><div class="nps-labels"><span>Not likely</span><span>Extremely likely</span></div></div>`
    default:
      return `<div class="field"><label>${field.label}${reqStar}</label><input type="text" name="${name}" ${req} /></div>`
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const survey = await knex('surveys').where('slug', slug).where('is_active', true).first()
    if (!survey) {
      return new NextResponse('<html><body style="font-family:Inter,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;color:#64748b"><h1>Survey not found</h1></body></html>', {
        status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    const fields = typeof survey.fields === 'string' ? JSON.parse(survey.fields) : survey.fields
    const fieldsHtml = fields.map((f: { id: string; type: string; label: string; required?: boolean; options?: string[] }) => renderField(f)).join('\n')

    const totalQuestions = fields.length

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(survey.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { -webkit-font-smoothing: antialiased; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #f8fafc; color: #1e293b; min-height: 100vh;
      display: flex; justify-content: center; padding: 3rem 1rem;
    }
    .container { width: 100%; max-width: 600px; }
    .card {
      background: #fff; border-radius: 16px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.03), 0 4px 16px rgba(0,0,0,0.06);
      padding: 2.5rem; margin-bottom: 1.5rem;
    }
    .header { margin-bottom: 2rem; }
    h1 { font-size: 1.625rem; font-weight: 700; color: #0f172a; letter-spacing: -0.02em; margin-bottom: 0.5rem; }
    .description { color: #64748b; font-size: 0.938rem; line-height: 1.6; }
    .progress { display: flex; align-items: center; gap: 10px; margin-bottom: 2rem; }
    .progress-bar { flex: 1; height: 4px; background: #e2e8f0; border-radius: 4px; overflow: hidden; }
    .progress-fill { height: 100%; background: #3b82f6; border-radius: 4px; transition: width 0.3s ease; width: 0%; }
    .progress-text { font-size: 0.75rem; color: #94a3b8; font-weight: 500; white-space: nowrap; }
    .section-label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin-bottom: 1rem; }
    .field { margin-bottom: 1.5rem; }
    .field label { display: block; font-size: 0.9375rem; font-weight: 500; margin-bottom: 0.5rem; color: #1e293b; line-height: 1.4; }
    .req { color: #ef4444; margin-left: 2px; }
    input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="date"],
    textarea, select {
      width: 100%; padding: 0.75rem 0.875rem; border: 1.5px solid #e2e8f0; border-radius: 10px;
      font-size: 0.9375rem; font-family: inherit; color: #1e293b; background: #fff;
      transition: border-color 0.2s, box-shadow 0.2s; outline: none;
    }
    input::placeholder, textarea::placeholder { color: #94a3b8; }
    input:focus, textarea:focus, select:focus {
      border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.1);
    }
    textarea { resize: vertical; min-height: 100px; }
    .options { display: flex; flex-direction: column; gap: 0.625rem; margin-top: 0.375rem; }
    .check-label {
      display: flex; align-items: center; gap: 0.625rem; font-size: 0.9375rem;
      font-weight: 400; cursor: pointer; color: #334155; padding: 0.5rem 0.75rem;
      border: 1.5px solid #e2e8f0; border-radius: 10px; transition: all 0.15s;
    }
    .check-label:hover { border-color: #cbd5e1; background: #f8fafc; }
    .check-label input { width: auto; margin: 0; accent-color: #3b82f6; }
    .check-label input:checked + span { color: #1e293b; font-weight: 500; }
    .rating { display: flex; gap: 6px; cursor: pointer; margin-top: 4px; }
    .star { font-size: 2rem; color: #d1d5db; transition: color 0.1s, transform 0.1s; user-select: none; }
    .star.active { color: #f59e0b; transform: scale(1.1); }
    .star:hover { color: #f59e0b; }
    .nps-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 0.375rem; }
    .nps-btn {
      width: 40px; height: 40px; border: 1.5px solid #e2e8f0; border-radius: 10px;
      background: #fff; color: #475569; font-size: 0.875rem; font-weight: 600;
      cursor: pointer; transition: all 0.15s;
    }
    .nps-btn:hover { border-color: #3b82f6; color: #3b82f6; background: #eff6ff; }
    .nps-btn.active { background: #3b82f6; color: #fff; border-color: #3b82f6; }
    .nps-labels { display: flex; justify-content: space-between; font-size: 0.75rem; color: #94a3b8; margin-top: 0.5rem; }
    .divider { border: none; border-top: 1px solid #f1f5f9; margin: 1.75rem 0; }
    .submit-btn {
      width: 100%; padding: 0.875rem 1.5rem; background: #3b82f6; color: #fff;
      border: none; border-radius: 12px; font-size: 1rem; font-weight: 600;
      cursor: pointer; transition: all 0.2s; margin-top: 0.75rem;
      font-family: inherit;
    }
    .submit-btn:hover { background: #2563eb; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(59,130,246,0.25); }
    .submit-btn:active { transform: translateY(0); }
    .submit-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; box-shadow: none; }
    .error-msg { color: #ef4444; font-size: 0.813rem; margin-top: 0.75rem; padding: 0.625rem 0.75rem; background: #fef2f2; border-radius: 8px; }
    .thank-you { text-align: center; padding: 3.5rem 2rem; }
    .thank-you .check-icon {
      width: 72px; height: 72px; background: linear-gradient(135deg, #ecfdf5, #d1fae5); border-radius: 50%;
      display: flex; align-items: center; justify-content: center; margin: 0 auto 1.25rem;
    }
    .thank-you .check-icon svg { width: 32px; height: 32px; stroke: #10b981; stroke-width: 2.5; fill: none; }
    .thank-you h2 { font-size: 1.375rem; font-weight: 700; color: #0f172a; margin-bottom: 0.5rem; letter-spacing: -0.01em; }
    .thank-you p { color: #64748b; font-size: 0.9375rem; line-height: 1.6; }
    @media (max-width: 640px) {
      body { padding: 1rem 0.75rem; }
      .card { padding: 1.75rem 1.25rem; border-radius: 12px; }
      h1 { font-size: 1.375rem; }
      .nps-btn { width: 36px; height: 36px; font-size: 0.8rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card" id="survey-form-card">
      <div class="header">
        <h1>${escapeHtml(survey.title)}</h1>
        ${survey.description ? `<p class="description">${escapeHtml(survey.description)}</p>` : ''}
      </div>
      <div class="progress">
        <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
        <span class="progress-text" id="progress-text">0 of ${totalQuestions}</span>
      </div>
      <form id="survey-form">
        <p class="section-label">Your Info</p>
        <div class="field">
          <label>Your Name</label>
          <input type="text" name="respondent_name" placeholder="Optional" />
        </div>
        <div class="field">
          <label>Your Email</label>
          <input type="email" name="respondent_email" placeholder="Optional" />
        </div>
        <hr class="divider" />
        <p class="section-label">Questions</p>
        ${fieldsHtml}
        <div id="form-error" class="error-msg" style="display:none"></div>
        <button type="submit" class="submit-btn" id="submit-btn">Submit</button>
      </form>
    </div>
    <div class="card thank-you" id="thank-you-card" style="display:none">
      <div class="check-icon"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>
      <h2>Thank you!</h2>
      <p id="thank-you-msg">${escapeHtml(survey.thank_you_message || 'Thank you for your response!')}</p>
    </div>
  </div>
  <script>
    // Progress tracking
    var totalQ = ${totalQuestions};
    function updateProgress() {
      var filled = 0;
      document.querySelectorAll('.field input, .field textarea, .field select').forEach(function(el) {
        if (el.name && el.name.startsWith('field_')) {
          if (el.type === 'hidden' && el.value) filled++;
          else if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) filled++; }
          else if (el.value && el.value.trim()) filled++;
        }
      });
      // Deduplicate radio groups
      var seen = {};
      filled = 0;
      document.querySelectorAll('.field').forEach(function(field) {
        var inputs = field.querySelectorAll('input, textarea, select');
        var hasValue = false;
        inputs.forEach(function(el) {
          if (!el.name || !el.name.startsWith('field_')) return;
          if (el.type === 'hidden' && el.value) hasValue = true;
          else if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) hasValue = true; }
          else if (el.value && el.value.trim()) hasValue = true;
        });
        if (hasValue && !seen[field.querySelector('label')?.textContent]) {
          seen[field.querySelector('label')?.textContent] = true;
          filled++;
        }
      });
      var pct = totalQ > 0 ? Math.round((filled / totalQ) * 100) : 0;
      document.getElementById('progress-fill').style.width = pct + '%';
      document.getElementById('progress-text').textContent = filled + ' of ' + totalQ;
    }
    document.getElementById('survey-form').addEventListener('input', updateProgress);
    document.getElementById('survey-form').addEventListener('change', updateProgress);

    // Rating stars
    document.querySelectorAll('.rating').forEach(function(container) {
      var stars = container.querySelectorAll('.star');
      var hidden = container.querySelector('input[type="hidden"]');
      stars.forEach(function(star, idx) {
        star.addEventListener('click', function() {
          var val = star.getAttribute('data-value');
          hidden.value = val;
          updateProgress();
          stars.forEach(function(s, i) {
            s.textContent = i < parseInt(val) ? '\\u2605' : '\\u2606';
            s.classList.toggle('active', i < parseInt(val));
          });
        });
        star.addEventListener('mouseenter', function() {
          stars.forEach(function(s, i) {
            s.classList.toggle('active', i <= idx);
          });
        });
      });
      container.addEventListener('mouseleave', function() {
        var val = parseInt(hidden.value) || 0;
        stars.forEach(function(s, i) {
          s.classList.toggle('active', i < val);
        });
      });
    });

    // NPS buttons
    function selectNps(btn, name) {
      var val = btn.getAttribute('data-value');
      document.querySelector('input[name="' + name + '"]').value = val;
      btn.parentElement.querySelectorAll('.nps-btn').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-value') === val);
      });
      updateProgress();
    }

    // Form submission
    document.getElementById('survey-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      var btn = document.getElementById('submit-btn');
      var errDiv = document.getElementById('form-error');
      btn.disabled = true;
      btn.textContent = 'Submitting...';
      errDiv.style.display = 'none';

      var fd = new FormData(e.target);
      var data = {};
      fd.forEach(function(val, key) {
        if (data[key] !== undefined) {
          if (!Array.isArray(data[key])) data[key] = [data[key]];
          data[key].push(val);
        } else {
          data[key] = val;
        }
      });

      try {
        var res = await fetch(window.location.pathname + '/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        var result = await res.json();
        if (result.ok) {
          document.getElementById('survey-form-card').style.display = 'none';
          if (result.thankYouMessage) document.getElementById('thank-you-msg').textContent = result.thankYouMessage;
          document.getElementById('thank-you-card').style.display = 'block';
        } else {
          errDiv.textContent = result.error || 'Something went wrong. Please try again.';
          errDiv.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Submit';
        }
      } catch {
        errDiv.textContent = 'Network error. Please try again.';
        errDiv.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Submit';
      }
    });
  </script>
</body>
</html>`

    return new NextResponse(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  } catch {
    return new NextResponse('<html><body>Error loading survey</body></html>', {
      status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }
}
