import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  GET: { requireAuth: false },
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

function renderField(field: any, index: number): string {
  const id = `field_${field.id}`
  const required = field.required ? 'required' : ''
  const requiredStar = field.required ? '<span class="required">*</span>' : ''
  const description = field.description ? `<p class="field-description">${escapeHtml(field.description)}</p>` : ''
  const widthClass = field.width === 'half' ? 'field-half' : 'field-full'
  const placeholder = field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : ''

  switch (field.type) {
    case 'section':
      return `<div class="field-full section-break"><h3>${escapeHtml(field.label)}</h3>${description}</div>`

    case 'page_break':
      return `<div class="page-break" data-page="${index}"></div>`

    case 'short_text':
      return `<div class="${widthClass}"><label for="${id}">${escapeHtml(field.label)}${requiredStar}</label>${description}<input type="text" id="${id}" name="${field.id}" ${placeholder} ${required} /></div>`

    case 'long_text':
      return `<div class="${widthClass}"><label for="${id}">${escapeHtml(field.label)}${requiredStar}</label>${description}<textarea id="${id}" name="${field.id}" rows="4" ${placeholder} ${required}></textarea></div>`

    case 'email':
      return `<div class="${widthClass}"><label for="${id}">${escapeHtml(field.label)}${requiredStar}</label>${description}<input type="email" id="${id}" name="${field.id}" ${placeholder} ${required} /></div>`

    case 'phone':
      return `<div class="${widthClass}"><label for="${id}">${escapeHtml(field.label)}${requiredStar}</label>${description}<input type="tel" id="${id}" name="${field.id}" ${placeholder} ${required} /></div>`

    case 'number':
      const min = field.validation?.min !== undefined ? `min="${field.validation.min}"` : ''
      const max = field.validation?.max !== undefined ? `max="${field.validation.max}"` : ''
      return `<div class="${widthClass}"><label for="${id}">${escapeHtml(field.label)}${requiredStar}</label>${description}<input type="number" id="${id}" name="${field.id}" ${placeholder} ${min} ${max} ${required} /></div>`

    case 'date':
      return `<div class="${widthClass}"><label for="${id}">${escapeHtml(field.label)}${requiredStar}</label>${description}<input type="date" id="${id}" name="${field.id}" ${required} /></div>`

    case 'select':
      const selectOptions = (field.options || []).map((o: string) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')
      return `<div class="${widthClass}"><label for="${id}">${escapeHtml(field.label)}${requiredStar}</label>${description}<select id="${id}" name="${field.id}" ${required}><option value="">Select...</option>${selectOptions}</select></div>`

    case 'multi_select':
      const checkboxes = (field.options || []).map((o: string, i: number) =>
        `<label class="checkbox-label"><input type="checkbox" name="${field.id}" value="${escapeHtml(o)}" /><span>${escapeHtml(o)}</span></label>`
      ).join('')
      return `<div class="${widthClass}"><label>${escapeHtml(field.label)}${requiredStar}</label>${description}<div class="checkbox-group">${checkboxes}</div></div>`

    case 'radio':
      const radios = (field.options || []).map((o: string) =>
        `<label class="radio-label"><input type="radio" name="${field.id}" value="${escapeHtml(o)}" ${required} /><span>${escapeHtml(o)}</span></label>`
      ).join('')
      return `<div class="${widthClass}"><label>${escapeHtml(field.label)}${requiredStar}</label>${description}<div class="radio-group">${radios}</div></div>`

    case 'checkbox':
      return `<div class="${widthClass}"><label class="checkbox-label single-check"><input type="checkbox" name="${field.id}" value="yes" ${required} /><span>${escapeHtml(field.label)}${requiredStar}</span></label>${description}</div>`

    case 'rating': {
      const maxVal = field.validation?.max || 5
      const stars = Array.from({ length: maxVal }, (_, i) => i + 1)
        .map((v) => `<button type="button" class="rating-star" data-field="${field.id}" data-value="${v}" aria-label="${v} star">${v <= 5 ? '&#9733;' : v}</button>`)
        .join('')
      return `<div class="${widthClass}"><label>${escapeHtml(field.label)}${requiredStar}</label>${description}<div class="rating-group" data-field="${field.id}">${stars}</div><input type="hidden" name="${field.id}" id="${id}" ${required} /></div>`
    }

    case 'yes_no':
      return `<div class="${widthClass}"><label>${escapeHtml(field.label)}${requiredStar}</label>${description}<div class="yes-no-group"><button type="button" class="yn-btn" data-field="${field.id}" data-value="yes">Yes</button><button type="button" class="yn-btn" data-field="${field.id}" data-value="no">No</button></div><input type="hidden" name="${field.id}" id="${id}" ${required} /></div>`

    case 'file':
      return `<div class="${widthClass}"><label for="${id}">${escapeHtml(field.label)}${requiredStar}</label>${description}<input type="file" id="${id}" name="${field.id}" ${required} /><p class="file-hint">Max 10 MB</p></div>`

    default:
      return `<div class="${widthClass}"><label for="${id}">${escapeHtml(field.label)}${requiredStar}</label><input type="text" id="${id}" name="${field.id}" ${placeholder} ${required} /></div>`
  }
}

function renderFormHtml(form: any): string {
  const theme = typeof form.theme === 'string' ? JSON.parse(form.theme || '{}') : (form.theme || {})
  const settings = typeof form.settings === 'string' ? JSON.parse(form.settings || '{}') : (form.settings || {})
  const fields = typeof form.fields === 'string' ? JSON.parse(form.fields || '[]') : (form.fields || [])

  const primaryColor = theme.primaryColor || '#6366f1'
  const backgroundColor = theme.background || theme.backgroundColor || '#f8fafc'
  const cardColor = theme.cardColor || '#ffffff'
  const textColor = theme.textColor || '#1e293b'
  const fontFamily = theme.font ? `'${theme.font}', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` : (theme.fontFamily || "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif")
  const cornerStyle = theme.corners || 'rounded'
  const borderRadius = cornerStyle === 'sharp' ? '4' : cornerStyle === 'pill' ? '20' : (theme.borderRadius || '12')
  const logoUrl = theme.logoUrl || ''
  const coverImageUrl = theme.coverImageUrl || ''

  const submitLabel = settings.submitLabel || settings.submitButtonText || 'Submit'
  const successMessage = settings.successMessage || 'Thank you! Your response has been recorded.'
  const successTitle = settings.successTitle || 'Submitted!'

  const baseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const submitUrl = `${baseUrl}/api/forms/public/${form.slug}/submit`

  const hasPageBreaks = fields.some((f: any) => f.type === 'page_break')

  const pages: any[][] = [[]]
  for (const field of fields) {
    if (field.type === 'page_break') {
      pages.push([])
    } else {
      pages[pages.length - 1].push(field)
    }
  }

  const fieldHtml = hasPageBreaks
    ? pages.map((pageFields, pageIdx) => {
        const renderedFields = pageFields.map((f: any, i: number) => renderField(f, i)).join('\n')
        return `<div class="form-page" data-page="${pageIdx}" ${pageIdx > 0 ? 'style="display:none"' : ''}>${renderedFields}</div>`
      }).join('\n')
    : `<div class="form-page active" data-page="0">${fields.map((f: any, i: number) => renderField(f, i)).join('\n')}</div>`

  const progressBar = hasPageBreaks
    ? `<div class="progress-bar-container"><div class="progress-bar" id="progressBar" style="width: ${Math.round(100 / pages.length)}%"></div></div><p class="page-indicator" id="pageIndicator">Page 1 of ${pages.length}</p>`
    : ''

  const pageNavigation = hasPageBreaks
    ? `<div class="page-navigation" id="pageNav"><button type="button" class="btn btn-secondary" id="prevBtn" style="display:none" onclick="changePage(-1)">Back</button><button type="button" class="btn btn-primary" id="nextBtn" onclick="changePage(1)">Next</button><button type="submit" class="btn btn-primary" id="submitBtnFinal" style="display:none">${escapeHtml(submitLabel)}</button></div>`
    : `<button type="submit" class="btn btn-primary submit-btn" id="submitBtn">${escapeHtml(submitLabel)}</button>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(form.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --primary: ${primaryColor};
    --primary-hover: color-mix(in srgb, ${primaryColor} 85%, black);
    --bg: ${backgroundColor};
    --card: ${cardColor};
    --text: ${textColor};
    --text-muted: color-mix(in srgb, ${textColor} 60%, transparent);
    --border: color-mix(in srgb, ${textColor} 12%, transparent);
    --border-focus: ${primaryColor};
    --radius: ${borderRadius}px;
    --radius-sm: ${Math.max(4, parseInt(borderRadius) - 4)}px;
    --font: ${fontFamily};
    --success: #10b981;
  }
  body { font-family: var(--font); background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 24px 16px 48px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
  .form-wrapper { width: 100%; max-width: 640px; }
  ${coverImageUrl ? `.cover-image { width: 100%; height: 200px; object-fit: cover; border-radius: var(--radius) var(--radius) 0 0; display: block; }` : ''}
  .form-card { background: var(--card); border-radius: var(--radius); box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04); overflow: hidden; ${coverImageUrl ? 'border-top-left-radius: 0; border-top-right-radius: 0;' : ''} }
  .form-header { padding: 32px 32px 0; text-align: center; }
  .form-header img.logo { height: 48px; margin-bottom: 16px; }
  .form-header h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; letter-spacing: -0.01em; }
  .form-header p { color: var(--text-muted); font-size: 15px; margin-bottom: 0; }
  .form-body { padding: 24px 32px 32px; }
  .form-page { display: flex; flex-wrap: wrap; gap: 16px; }
  .field-full { width: 100%; }
  .field-half { width: calc(50% - 8px); }
  @media (max-width: 540px) { .field-half { width: 100%; } .form-header, .form-body { padding-left: 20px; padding-right: 20px; } }
  label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 6px; }
  .required { color: #ef4444; margin-left: 2px; }
  .field-description { font-size: 13px; color: var(--text-muted); margin-bottom: 6px; margin-top: -2px; }
  input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="date"], input[type="url"], select, textarea {
    width: 100%; padding: 10px 14px; border: 1.5px solid var(--border); border-radius: var(--radius-sm);
    font-size: 16px; font-family: var(--font); color: var(--text); background: var(--card);
    transition: border-color 0.2s, box-shadow 0.2s; outline: none;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--border-focus); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 15%, transparent); }
  textarea { resize: vertical; min-height: 100px; }
  select { appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236b7280' d='M2 4l4 4 4-4'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; padding-right: 36px; }
  input[type="file"] { padding: 10px; border: 1.5px dashed var(--border); border-radius: var(--radius-sm); cursor: pointer; font-size: 14px; }
  input[type="file"]:focus { border-color: var(--border-focus); }
  .file-hint { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
  .checkbox-group, .radio-group { display: flex; flex-wrap: wrap; gap: 8px; }
  .checkbox-label, .radio-label { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 400; cursor: pointer; padding: 8px 14px; border: 1.5px solid var(--border); border-radius: var(--radius-sm); transition: border-color 0.15s, background 0.15s; }
  .checkbox-label:hover, .radio-label:hover { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 4%, transparent); }
  .checkbox-label input, .radio-label input { accent-color: var(--primary); }
  .single-check { border: none; padding: 0; margin-bottom: 0; }
  .single-check:hover { background: transparent; }
  .rating-group { display: flex; gap: 4px; }
  .rating-star { background: none; border: none; font-size: 28px; color: var(--border); cursor: pointer; padding: 2px 4px; transition: color 0.15s, transform 0.15s; }
  .rating-star:hover, .rating-star.active { color: #f59e0b; transform: scale(1.15); }
  .yes-no-group { display: flex; gap: 8px; }
  .yn-btn { padding: 10px 28px; border: 1.5px solid var(--border); border-radius: var(--radius-sm); background: var(--card); font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.15s; font-family: var(--font); }
  .yn-btn:hover { border-color: var(--primary); }
  .yn-btn.active { background: var(--primary); color: white; border-color: var(--primary); }
  .section-break { padding-top: 8px; }
  .section-break h3 { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
  .progress-bar-container { height: 4px; background: var(--border); border-radius: 2px; margin: 0 32px 8px; overflow: hidden; }
  .progress-bar { height: 100%; background: var(--primary); border-radius: 2px; transition: width 0.3s ease; }
  .page-indicator { text-align: center; font-size: 13px; color: var(--text-muted); margin-bottom: 8px; }
  .page-navigation { display: flex; justify-content: space-between; gap: 12px; margin-top: 20px; }
  .btn { padding: 12px 24px; border-radius: var(--radius-sm); font-size: 15px; font-weight: 600; cursor: pointer; border: none; font-family: var(--font); transition: all 0.2s; }
  .btn-primary { background: var(--primary); color: white; width: 100%; }
  .btn-primary:hover { background: var(--primary-hover); transform: translateY(-1px); box-shadow: 0 4px 12px color-mix(in srgb, var(--primary) 30%, transparent); }
  .btn-primary:active { transform: translateY(0); }
  .btn-secondary { background: var(--card); color: var(--text); border: 1.5px solid var(--border); }
  .btn-secondary:hover { border-color: var(--text-muted); }
  .submit-btn { margin-top: 20px; }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none !important; }
  .success-state { text-align: center; padding: 48px 32px; }
  .success-icon { width: 64px; height: 64px; background: color-mix(in srgb, var(--success) 12%, transparent); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; }
  .success-icon svg { width: 32px; height: 32px; color: var(--success); }
  .success-state h2 { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
  .success-state p { color: var(--text-muted); font-size: 15px; }
  .field-error { color: #dc2626; font-size: 13px; margin-top: 6px; }
  .field-invalid input, .field-invalid select, .field-invalid textarea { border-color: #ef4444; }
  .error-message { background: #fef2f2; border: 1px solid #fecaca; color: #dc2626; padding: 10px 14px; border-radius: var(--radius-sm); font-size: 14px; margin-bottom: 16px; display: none; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  .form-card { animation: fadeIn 0.4s ease; }
</style>
</head>
<body>
<div class="form-wrapper">
  ${coverImageUrl ? `<img class="cover-image" src="${escapeHtml(coverImageUrl)}" alt="" />` : ''}
  <div class="form-card">
    <div id="formView">
      <div class="form-header">
        ${logoUrl ? `<img class="logo" src="${escapeHtml(logoUrl)}" alt="Logo" />` : ''}
        <h1>${escapeHtml(form.name)}</h1>
        ${form.description ? `<p>${escapeHtml(form.description)}</p>` : ''}
      </div>
      ${progressBar}
      <div class="form-body">
        <div class="error-message" id="errorMsg"></div>
        <form id="formEl" novalidate>
          ${fieldHtml}
          ${pageNavigation}
        </form>
      </div>
    </div>
    <div id="successView" style="display:none">
      <div class="success-state">
        <div class="success-icon">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
        </div>
        <h2>${escapeHtml(successTitle)}</h2>
        <p>${escapeHtml(successMessage)}</p>
      </div>
    </div>
  </div>
</div>
<script>
(function() {
  var form = document.getElementById('formEl');
  var errorMsg = document.getElementById('errorMsg');
  var currentPage = 0;
  var totalPages = ${pages.length};

  // Rating stars
  document.querySelectorAll('.rating-star').forEach(function(star) {
    star.addEventListener('click', function() {
      var field = this.dataset.field;
      var value = this.dataset.value;
      document.querySelector('input[name="' + field + '"]').value = value;
      var group = this.closest('.rating-group');
      group.querySelectorAll('.rating-star').forEach(function(s) {
        s.classList.toggle('active', parseInt(s.dataset.value) <= parseInt(value));
      });
    });
  });

  // Yes/No buttons
  document.querySelectorAll('.yn-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var field = this.dataset.field;
      var value = this.dataset.value;
      document.querySelector('input[name="' + field + '"]').value = value;
      this.parentElement.querySelectorAll('.yn-btn').forEach(function(b) { b.classList.remove('active'); });
      this.classList.add('active');
    });
  });

  ${hasPageBreaks ? `
  window.changePage = function(dir) {
    var pages = document.querySelectorAll('.form-page');
    pages[currentPage].style.display = 'none';
    currentPage += dir;
    pages[currentPage].style.display = 'flex';
    document.getElementById('prevBtn').style.display = currentPage > 0 ? '' : 'none';
    document.getElementById('nextBtn').style.display = currentPage < totalPages - 1 ? '' : 'none';
    document.getElementById('submitBtnFinal').style.display = currentPage === totalPages - 1 ? '' : 'none';
    document.getElementById('progressBar').style.width = ((currentPage + 1) / totalPages * 100) + '%';
    document.getElementById('pageIndicator').textContent = 'Page ' + (currentPage + 1) + ' of ' + totalPages;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };` : ''}

  var EMAIL_RE = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;

  function fieldWrap(el) { return el && el.closest ? el.closest('.field-full, .field-half') : null; }

  function clearFieldErrors() {
    form.querySelectorAll('.field-error').forEach(function(n) { n.parentNode.removeChild(n); });
    form.querySelectorAll('.field-invalid').forEach(function(n) { n.classList.remove('field-invalid'); });
  }

  function showFieldError(wrap, message) {
    if (!wrap) return;
    wrap.classList.add('field-invalid');
    var p = document.createElement('p');
    p.className = 'field-error';
    p.setAttribute('role', 'alert');
    p.textContent = message;
    wrap.appendChild(p);
  }

  function pageOf(el) {
    var page = el && el.closest ? el.closest('.form-page') : null;
    return page ? parseInt(page.getAttribute('data-page') || '0', 10) : 0;
  }

  function goToPage(index) {
    if (totalPages <= 1 || index === currentPage || !window.changePage) return;
    window.changePage(index - currentPage);
  }

  // Native validation is off (novalidate) so errors show inline, in plain
  // English, next to each field. Nothing is sent until every field passes.
  function validateAll() {
    clearFieldErrors();
    var firstBad = null;
    var handled = {};
    Array.prototype.forEach.call(form.elements, function(el) {
      if (!el.name || handled[el.name] || el.type === 'submit' || el.type === 'button') return;
      var message = null;
      var value = (el.value || '').trim();
      if (el.type === 'hidden') {
        if (el.hasAttribute('required') && !value) message = 'Please choose an answer.';
      } else if (el.type === 'radio' || el.type === 'checkbox') {
        if (el.hasAttribute('required')) {
          var group = form.querySelectorAll('input[name="' + el.name + '"]');
          var any = Array.prototype.some.call(group, function(g) { return g.checked; });
          if (!any) message = el.type === 'radio' ? 'Please choose an answer.' : 'This field is required.';
        }
      } else if (el.hasAttribute('required') && !value) {
        message = 'This field is required.';
      } else if (el.type === 'email' && value && !EMAIL_RE.test(value)) {
        message = 'Enter a valid email address, like name@example.com.';
      } else if (el.checkValidity && !el.checkValidity()) {
        message = el.validationMessage || 'Please check this answer.';
      }
      if (message) {
        handled[el.name] = true;
        showFieldError(fieldWrap(el), message);
        if (!firstBad) firstBad = el;
      }
    });
    if (firstBad) {
      goToPage(pageOf(firstBad));
      var target = firstBad.type === 'hidden' ? fieldWrap(firstBad) : firstBad;
      if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (firstBad.type !== 'hidden' && firstBad.focus) { try { firstBad.focus({ preventScroll: true }); } catch (err) {} }
      return false;
    }
    return true;
  }

  function clearOne(e) {
    var wrap = fieldWrap(e.target);
    if (!wrap || !wrap.classList.contains('field-invalid')) return;
    wrap.classList.remove('field-invalid');
    wrap.querySelectorAll('.field-error').forEach(function(n) { n.parentNode.removeChild(n); });
  }
  form.addEventListener('input', clearOne);
  form.addEventListener('change', clearOne);

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    errorMsg.style.display = 'none';
    if (!validateAll()) return;

    var data = {};
    var formData = new FormData(form);
    var multiSelectFields = {};
    formData.forEach(function(value, key) {
      if (data[key] !== undefined) {
        if (!multiSelectFields[key]) {
          multiSelectFields[key] = [data[key]];
        }
        multiSelectFields[key].push(value);
      } else {
        data[key] = value;
      }
    });
    for (var k in multiSelectFields) {
      data[k] = multiSelectFields[k];
    }

    var submitBtn = form.querySelector('[type="submit"]') || document.getElementById('submitBtnFinal') || document.getElementById('submitBtn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting...'; }

    fetch('${submitUrl}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
    .then(function(r) { return r.json(); })
    .then(function(r) {
      if (r.ok) {
        document.getElementById('formView').style.display = 'none';
        document.getElementById('successView').style.display = 'block';
        if (r.redirectUrl) { setTimeout(function() { window.location.href = r.redirectUrl; }, 2000); }
      } else {
        var badField = r.field ? form.querySelector('[name="' + String(r.field).replace(/"/g, '') + '"]') : null;
        if (badField && fieldWrap(badField)) {
          showFieldError(fieldWrap(badField), r.error || 'Please check this answer.');
          goToPage(pageOf(badField));
          if (fieldWrap(badField).scrollIntoView) fieldWrap(badField).scrollIntoView({ block: 'center', behavior: 'smooth' });
        } else {
          errorMsg.textContent = r.error || 'Something went wrong. Please try again.';
          errorMsg.style.display = 'block';
        }
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '${escapeHtml(submitLabel)}'; }
      }
    })
    .catch(function() {
      errorMsg.textContent = 'Network error. Please check your connection and try again.';
      errorMsg.style.display = 'block';
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '${escapeHtml(submitLabel)}'; }
    });
  });
})();
</script>
</body>
</html>`
}

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const form = await knex('forms')
      .where('slug', params.slug)
      .where('status', 'published')
      .where('is_active', true)
      .first()

    if (!form) {
      const html404 = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Form not found</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8fafc;color:#1e293b;text-align:center}h1{font-size:22px;font-weight:600;margin-bottom:8px}p{color:#64748b;font-size:15px}</style></head><body><div><h1>Form not found</h1><p>This form may have been removed or is no longer accepting responses.</p></div></body></html>`
      return new NextResponse(html404, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }

    await knex('forms').where('id', form.id).increment('view_count', 1)

    const html = renderFormHtml(form)
    return new NextResponse(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      },
    })
  } catch (error) {
    console.error('[forms.public.serve] failed', error)
    return new NextResponse('Server error', { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Forms (Public)',
  summary: 'Render published form',
  methods: { GET: { summary: 'Serve published form as HTML page', tags: ['Forms (Public)'] } },
}
