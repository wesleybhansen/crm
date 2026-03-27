import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export const metadata = { GET: { requireAuth: false } }

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

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(survey.title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f8fafc; color: #1e293b; min-height: 100vh;
      display: flex; justify-content: center; padding: 2rem 1rem;
    }
    .container { width: 100%; max-width: 640px; }
    .card {
      background: #fff; border-radius: 12px; border: 1px solid #e2e8f0;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06); padding: 2rem; margin-bottom: 1.5rem;
    }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.5rem; color: #0f172a; }
    .description { color: #64748b; font-size: 0.938rem; line-height: 1.5; margin-bottom: 1.5rem; }
    .field { margin-bottom: 1.25rem; }
    .field label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.375rem; color: #334155; }
    .req { color: #ef4444; margin-left: 2px; }
    input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="date"],
    textarea, select {
      width: 100%; padding: 0.625rem 0.75rem; border: 1px solid #cbd5e1; border-radius: 8px;
      font-size: 0.875rem; font-family: inherit; color: #1e293b; background: #fff;
      transition: border-color 0.15s, box-shadow 0.15s; outline: none;
    }
    input:focus, textarea:focus, select:focus {
      border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.1);
    }
    textarea { resize: vertical; }
    .options { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.25rem; }
    .check-label {
      display: flex; align-items: center; gap: 0.5rem; font-size: 0.875rem;
      font-weight: 400; cursor: pointer; color: #334155;
    }
    .check-label input { width: auto; margin: 0; }
    .rating { display: flex; gap: 0.25rem; cursor: pointer; }
    .star { font-size: 1.75rem; color: #cbd5e1; transition: color 0.1s; user-select: none; }
    .star.active { color: #f59e0b; }
    .star:hover { color: #f59e0b; }
    .nps-row { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 0.25rem; }
    .nps-btn {
      width: 36px; height: 36px; border: 1px solid #cbd5e1; border-radius: 6px;
      background: #fff; color: #334155; font-size: 0.813rem; font-weight: 500;
      cursor: pointer; transition: all 0.15s;
    }
    .nps-btn:hover { border-color: #3b82f6; color: #3b82f6; }
    .nps-btn.active { background: #3b82f6; color: #fff; border-color: #3b82f6; }
    .nps-labels { display: flex; justify-content: space-between; font-size: 0.75rem; color: #94a3b8; margin-top: 0.375rem; }
    .submit-btn {
      width: 100%; padding: 0.75rem 1.5rem; background: #3b82f6; color: #fff;
      border: none; border-radius: 8px; font-size: 0.938rem; font-weight: 500;
      cursor: pointer; transition: background 0.15s; margin-top: 0.5rem;
    }
    .submit-btn:hover { background: #2563eb; }
    .submit-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .error-msg { color: #ef4444; font-size: 0.813rem; margin-top: 0.5rem; }
    .thank-you {
      text-align: center; padding: 3rem 2rem;
    }
    .thank-you .check-icon {
      width: 64px; height: 64px; background: #ecfdf5; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem;
      color: #10b981; font-size: 2rem;
    }
    .thank-you h2 { font-size: 1.25rem; font-weight: 600; color: #0f172a; margin-bottom: 0.5rem; }
    .thank-you p { color: #64748b; font-size: 0.938rem; }
    .powered { text-align: center; color: #94a3b8; font-size: 0.75rem; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card" id="survey-form-card">
      <h1>${escapeHtml(survey.title)}</h1>
      ${survey.description ? `<p class="description">${escapeHtml(survey.description)}</p>` : ''}
      <form id="survey-form">
        <div class="field">
          <label>Your Name</label>
          <input type="text" name="respondent_name" placeholder="Optional" />
        </div>
        <div class="field">
          <label>Your Email</label>
          <input type="email" name="respondent_email" placeholder="Optional" />
        </div>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:1.25rem 0" />
        ${fieldsHtml}
        <div id="form-error" class="error-msg" style="display:none"></div>
        <button type="submit" class="submit-btn" id="submit-btn">Submit</button>
      </form>
    </div>
    <div class="card thank-you" id="thank-you-card" style="display:none">
      <div class="check-icon">&#10003;</div>
      <h2>Submitted!</h2>
      <p id="thank-you-msg">${escapeHtml(survey.thank_you_message || 'Thank you for your response!')}</p>
    </div>
    <div class="powered">Powered by Open Mercato</div>
  </div>
  <script>
    // Rating stars
    document.querySelectorAll('.rating').forEach(function(container) {
      var stars = container.querySelectorAll('.star');
      var hidden = container.querySelector('input[type="hidden"]');
      stars.forEach(function(star, idx) {
        star.addEventListener('click', function() {
          var val = star.getAttribute('data-value');
          hidden.value = val;
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
