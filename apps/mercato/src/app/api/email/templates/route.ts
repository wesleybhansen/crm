import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

function makeTemplate(name: string, category: string, html: string) {
  return { name, category, html_template: html, is_default: true }
}

function wrapEmail(preheaderColor: string, bodyContent: string): string {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta http-equiv="X-UA-Compatible" content="IE=edge"/>
<title>{{subject}}</title>
<style type="text/css">
@media only screen and (max-width:620px){.wrapper{width:100%!important;padding:0 16px!important}.col{width:100%!important;display:block!important}.hero-text{font-size:22px!important}.btn-td{padding:12px 24px!important}}body,table,td,p,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}table,td{mso-table-lspace:0;mso-table-rspace:0}img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none}body{margin:0;padding:0;width:100%!important;background-color:#f4f4f7}
</style>
<!--[if mso]><style>table{border-collapse:collapse}td{font-family:Arial,sans-serif}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
<span style="display:none;font-size:1px;color:${preheaderColor};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">{{subject}}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7"><tr><td align="center" style="padding:24px 0">
<table role="presentation" class="wrapper" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
${bodyContent}
</table>
</td></tr></table>
</body>
</html>`
}

const DEFAULT_TEMPLATES = [
  // 1. Clean Newsletter
  makeTemplate('Clean Newsletter', 'newsletter', wrapEmail('#f4f4f7', `
<tr><td align="center" style="padding:32px 0 16px">
  <table role="presentation" width="140" cellpadding="0" cellspacing="0"><tr><td align="center" style="font-size:20px;font-weight:700;color:{{brand_primary}};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Your Logo</td></tr></table>
</td></tr>
<tr><td>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{{brand_bg}};border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">
    <tr><td style="padding:40px 40px 0">
      <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#111827;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;line-height:1.3">{{subject}}</h1>
      <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Your latest updates, curated just for you.</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 24px"/>
    </td></tr>
    <tr><td style="padding:0 40px 40px;font-size:15px;line-height:1.7;color:#374151;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
      {{content}}
    </td></tr>
  </table>
</td></tr>
<tr><td style="padding:24px 0;text-align:center">
  <p style="margin:0;font-size:12px;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;line-height:1.5">You received this because you subscribed to our newsletter.</p>
  <p style="margin:8px 0 0;font-size:12px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif"><a href="{{preference_url}}" style="color:#6b7280;text-decoration:underline">Email preferences</a> &bull; <a href="{{unsubscribe_url}}" style="color:#6b7280;text-decoration:underline">Unsubscribe</a></p>
</td></tr>`)),

  // 2. Bold Announcement
  makeTemplate('Bold Announcement', 'announcement', wrapEmail('#1e293b', `
<tr><td>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{{brand_primary}};border-radius:8px 8px 0 0">
    <tr><td style="padding:20px 40px">
      <span style="font-size:16px;font-weight:700;color:#ffffff;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Your Logo</span>
    </td></tr>
    <tr><td style="padding:32px 40px 48px;text-align:center">
      <h1 class="hero-text" style="margin:0 0 16px;font-size:32px;font-weight:800;color:#ffffff;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;line-height:1.2">{{subject}}</h1>
      <p style="margin:0 0 32px;font-size:16px;color:rgba(255,255,255,0.85);line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Big things are happening. Read on for the full details.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr><td class="btn-td" style="background-color:#ffffff;border-radius:6px;padding:14px 32px">
        <a href="#" style="font-size:14px;font-weight:700;color:{{brand_primary}};text-decoration:none;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;display:inline-block">Learn More &rarr;</a>
      </td></tr></table>
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{{brand_bg}};border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none">
    <tr><td style="padding:40px;font-size:15px;line-height:1.7;color:#374151;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
      {{content}}
    </td></tr>
  </table>
</td></tr>
<tr><td style="padding:24px 0;text-align:center">
  <p style="margin:0;font-size:12px;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif"><a href="{{preference_url}}" style="color:#9ca3af;text-decoration:underline">Preferences</a> &bull; <a href="{{unsubscribe_url}}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a></p>
</td></tr>`)),

  // 3. Product Launch
  makeTemplate('Product Launch', 'product', wrapEmail('#f4f4f7', `
<tr><td align="center" style="padding:32px 0 20px">
  <span style="font-size:18px;font-weight:700;color:{{brand_primary}};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Your Logo</span>
</td></tr>
<tr><td>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{{brand_bg}};border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">
    <tr><td style="padding:0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,{{brand_primary}},{{brand_secondary}});background-color:{{brand_primary}}">
        <tr><td style="padding:48px 40px;text-align:center">
          <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:2px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Now Available</p>
          <h1 class="hero-text" style="margin:0 0 16px;font-size:28px;font-weight:800;color:#ffffff;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;line-height:1.2">{{subject}}</h1>
          <p style="margin:0;font-size:15px;color:rgba(255,255,255,0.85);line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Designed to make your life easier.</p>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:32px 40px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td class="col" width="48%" valign="top" style="padding-right:16px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:8px;padding:20px">
              <tr><td style="padding:20px">
                <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:{{brand_primary}};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Feature 1</p>
                <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Lightning fast performance for your workflow.</p>
              </td></tr>
            </table>
          </td>
          <td class="col" width="48%" valign="top" style="padding-left:16px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:8px">
              <tr><td style="padding:20px">
                <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:{{brand_primary}};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Feature 2</p>
                <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Built-in integrations with your favorite tools.</p>
              </td></tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 40px 32px;font-size:15px;line-height:1.7;color:#374151;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
      {{content}}
    </td></tr>
    <tr><td align="center" style="padding:0 40px 40px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td class="btn-td" style="background-color:{{brand_primary}};border-radius:6px;padding:14px 32px">
        <a href="#" style="font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Get Started &rarr;</a>
      </td></tr></table>
    </td></tr>
  </table>
</td></tr>
<tr><td style="padding:24px 0;text-align:center">
  <p style="margin:0;font-size:12px;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif"><a href="{{preference_url}}" style="color:#9ca3af;text-decoration:underline">Preferences</a> &bull; <a href="{{unsubscribe_url}}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a></p>
</td></tr>`)),

  // 4. Welcome Email
  makeTemplate('Welcome Email', 'onboarding', wrapEmail('#f4f4f7', `
<tr><td align="center" style="padding:32px 0 20px">
  <span style="font-size:18px;font-weight:700;color:{{brand_primary}};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Your Logo</span>
</td></tr>
<tr><td>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{{brand_bg}};border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">
    <tr><td style="padding:48px 40px;text-align:center;background-color:#fefce8;border-bottom:1px solid #fde68a">
      <p style="margin:0;font-size:40px;line-height:1">&#128075;</p>
      <h1 style="margin:16px 0 8px;font-size:26px;font-weight:700;color:#111827;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;line-height:1.3">Welcome aboard!</h1>
      <p style="margin:0;font-size:15px;color:#6b7280;line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">We're thrilled to have you. Here's everything you need to get started.</p>
    </td></tr>
    <tr><td style="padding:32px 40px;font-size:15px;line-height:1.7;color:#374151;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
      {{content}}
    </td></tr>
    <tr><td style="padding:0 40px 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0">
        <tr><td style="padding:20px">
          <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#15803d;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Quick Start</p>
          <p style="margin:0;font-size:13px;color:#166534;line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">1. Complete your profile &bull; 2. Explore features &bull; 3. Invite your team</p>
        </td></tr>
      </table>
    </td></tr>
    <tr><td align="center" style="padding:16px 40px 40px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td class="btn-td" style="background-color:{{brand_primary}};border-radius:6px;padding:14px 32px">
        <a href="#" style="font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Get Started &rarr;</a>
      </td></tr></table>
    </td></tr>
  </table>
</td></tr>
<tr><td style="padding:24px 0;text-align:center">
  <p style="margin:0;font-size:12px;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif"><a href="{{preference_url}}" style="color:#9ca3af;text-decoration:underline">Preferences</a> &bull; <a href="{{unsubscribe_url}}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a></p>
</td></tr>`)),

  // 5. Promotion / Sale
  makeTemplate('Promotion / Sale', 'promotion', wrapEmail('#f4f4f7', `
<tr><td>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#dc2626;border-radius:8px 8px 0 0">
    <tr><td style="padding:16px 40px">
      <span style="font-size:16px;font-weight:700;color:#ffffff;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Your Logo</span>
    </td><td style="padding:16px 40px;text-align:right">
      <span style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.8);text-transform:uppercase;letter-spacing:1.5px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Limited Time</span>
    </td></tr>
    <tr><td colspan="2" style="padding:24px 40px 48px;text-align:center">
      <p style="margin:0 0 4px;font-size:14px;color:rgba(255,255,255,0.8);font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Don't miss out</p>
      <h1 class="hero-text" style="margin:0 0 8px;font-size:48px;font-weight:900;color:#ffffff;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;line-height:1">SALE</h1>
      <p style="margin:0 0 24px;font-size:18px;color:#fecaca;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:600">{{subject}}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr><td class="btn-td" style="background-color:#ffffff;border-radius:6px;padding:14px 32px">
        <a href="#" style="font-size:14px;font-weight:800;color:#dc2626;text-decoration:none;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Shop Now &rarr;</a>
      </td></tr></table>
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{{brand_bg}};border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none">
    <tr><td style="padding:40px;font-size:15px;line-height:1.7;color:#374151;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
      {{content}}
    </td></tr>
    <tr><td style="padding:0 40px 32px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fef2f2;border-radius:8px;border:1px solid #fecaca">
        <tr><td style="padding:16px 20px;text-align:center">
          <p style="margin:0;font-size:13px;color:#991b1b;font-weight:600;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">&#9200; Hurry! This offer expires soon.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</td></tr>
<tr><td style="padding:24px 0;text-align:center">
  <p style="margin:0;font-size:12px;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif"><a href="{{preference_url}}" style="color:#9ca3af;text-decoration:underline">Preferences</a> &bull; <a href="{{unsubscribe_url}}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a></p>
</td></tr>`)),

  // 6. Event Invitation
  makeTemplate('Event Invitation', 'event', wrapEmail('#f4f4f7', `
<tr><td align="center" style="padding:32px 0 20px">
  <span style="font-size:18px;font-weight:700;color:{{brand_primary}};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Your Logo</span>
</td></tr>
<tr><td>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{{brand_bg}};border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">
    <tr><td style="padding:40px 40px 0;text-align:center">
      <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:{{brand_primary}};text-transform:uppercase;letter-spacing:2px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">You're Invited</p>
      <h1 style="margin:0 0 24px;font-size:26px;font-weight:700;color:#111827;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;line-height:1.3">{{subject}}</h1>
    </td></tr>
    <tr><td style="padding:0 40px 24px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eff6ff;border-radius:8px;border:1px solid #bfdbfe">
        <tr>
          <td width="33%" style="padding:20px;text-align:center;border-right:1px solid #bfdbfe">
            <p style="margin:0;font-size:11px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:1px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Date</p>
            <p style="margin:4px 0 0;font-size:14px;font-weight:600;color:#1e3a5f;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">TBD</p>
          </td>
          <td width="34%" style="padding:20px;text-align:center;border-right:1px solid #bfdbfe">
            <p style="margin:0;font-size:11px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:1px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Time</p>
            <p style="margin:4px 0 0;font-size:14px;font-weight:600;color:#1e3a5f;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">TBD</p>
          </td>
          <td width="33%" style="padding:20px;text-align:center">
            <p style="margin:0;font-size:11px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:1px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Venue</p>
            <p style="margin:4px 0 0;font-size:14px;font-weight:600;color:#1e3a5f;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">TBD</p>
          </td>
        </tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 40px 24px;font-size:15px;line-height:1.7;color:#374151;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
      {{content}}
    </td></tr>
    <tr><td align="center" style="padding:0 40px 40px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td class="btn-td" style="background-color:{{brand_primary}};border-radius:6px;padding:14px 32px">
        <a href="#" style="font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">RSVP Now &rarr;</a>
      </td></tr></table>
    </td></tr>
  </table>
</td></tr>
<tr><td style="padding:24px 0;text-align:center">
  <p style="margin:0;font-size:12px;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif"><a href="{{preference_url}}" style="color:#9ca3af;text-decoration:underline">Preferences</a> &bull; <a href="{{unsubscribe_url}}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a></p>
</td></tr>`)),

  // 7. Weekly Digest
  makeTemplate('Weekly Digest', 'newsletter', wrapEmail('#f4f4f7', `
<tr><td>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{{brand_primary}};border-radius:8px 8px 0 0">
    <tr><td style="padding:24px 40px">
      <span style="font-size:16px;font-weight:700;color:#ffffff;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Your Logo</span>
    </td><td style="padding:24px 40px;text-align:right">
      <span style="font-size:12px;color:rgba(255,255,255,0.8);font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Weekly Digest</span>
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{{brand_bg}};border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none">
    <tr><td style="padding:32px 40px 16px">
      <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;color:#111827;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">{{subject}}</h1>
      <p style="margin:0;font-size:13px;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Your top stories this week</p>
    </td></tr>
    <tr><td style="padding:16px 40px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb">
        <tr><td style="padding:20px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td class="col" width="72" valign="top"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="width:64px;height:64px;background-color:#f3f4f6;border-radius:8px">&nbsp;</td></tr></table></td>
            <td valign="top" style="padding-left:16px">
              <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#111827;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Article Title Here</p>
              <p style="margin:0 0 8px;font-size:13px;color:#6b7280;line-height:1.5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">A brief description of the article content goes here...</p>
              <a href="#" style="font-size:12px;font-weight:600;color:{{brand_primary}};text-decoration:none;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Read more &rarr;</a>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:20px 0;border-top:1px solid #e5e7eb">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td class="col" width="72" valign="top"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="width:64px;height:64px;background-color:#f3f4f6;border-radius:8px">&nbsp;</td></tr></table></td>
            <td valign="top" style="padding-left:16px">
              <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#111827;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Another Article Title</p>
              <p style="margin:0 0 8px;font-size:13px;color:#6b7280;line-height:1.5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">More great content for your reading pleasure...</p>
              <a href="#" style="font-size:12px;font-weight:600;color:{{brand_primary}};text-decoration:none;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Read more &rarr;</a>
            </td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 40px 32px;font-size:15px;line-height:1.7;color:#374151;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
      {{content}}
    </td></tr>
  </table>
</td></tr>
<tr><td style="padding:24px 0;text-align:center">
  <p style="margin:0;font-size:12px;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif"><a href="{{preference_url}}" style="color:#9ca3af;text-decoration:underline">Preferences</a> &bull; <a href="{{unsubscribe_url}}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a></p>
</td></tr>`)),

  // 8. Testimonial Spotlight
  makeTemplate('Testimonial Spotlight', 'social-proof', wrapEmail('#f4f4f7', `
<tr><td align="center" style="padding:32px 0 20px">
  <span style="font-size:18px;font-weight:700;color:{{brand_primary}};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Your Logo</span>
</td></tr>
<tr><td>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{{brand_bg}};border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">
    <tr><td style="padding:40px 40px 24px;text-align:center">
      <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#111827;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">{{subject}}</h1>
      <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Hear what our customers have to say</p>
    </td></tr>
    <tr><td style="padding:0 40px 32px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:12px;border:1px solid #e5e7eb">
        <tr><td style="padding:32px;text-align:center">
          <p style="margin:0 0 16px;font-size:32px;line-height:1;color:#d1d5db">&ldquo;</p>
          <p style="margin:0 0 20px;font-size:16px;font-style:italic;color:#374151;line-height:1.7;font-family:Georgia,'Times New Roman',serif">"This product has completely transformed the way we work. The results speak for themselves."</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>
            <td style="width:48px;height:48px;background-color:#e5e7eb;border-radius:50%">&nbsp;</td>
            <td style="padding-left:12px;text-align:left">
              <p style="margin:0;font-size:14px;font-weight:700;color:#111827;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Customer Name</p>
              <p style="margin:2px 0 0;font-size:12px;color:#6b7280;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Title, Company</p>
            </td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 40px 40px;font-size:15px;line-height:1.7;color:#374151;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
      {{content}}
    </td></tr>
    <tr><td align="center" style="padding:0 40px 40px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td class="btn-td" style="background-color:{{brand_primary}};border-radius:6px;padding:14px 32px">
        <a href="#" style="font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">See More Stories &rarr;</a>
      </td></tr></table>
    </td></tr>
  </table>
</td></tr>
<tr><td style="padding:24px 0;text-align:center">
  <p style="margin:0;font-size:12px;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif"><a href="{{preference_url}}" style="color:#9ca3af;text-decoration:underline">Preferences</a> &bull; <a href="{{unsubscribe_url}}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a></p>
</td></tr>`)),

  // 9. Tips & Education
  makeTemplate('Tips & Education', 'educational', wrapEmail('#f4f4f7', `
<tr><td align="center" style="padding:32px 0 20px">
  <span style="font-size:18px;font-weight:700;color:{{brand_primary}};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Your Logo</span>
</td></tr>
<tr><td>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{{brand_bg}};border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">
    <tr><td style="padding:40px 40px 24px">
      <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:{{brand_primary}};text-transform:uppercase;letter-spacing:2px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Pro Tips</p>
      <h1 style="margin:0;font-size:24px;font-weight:700;color:#111827;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;line-height:1.3">{{subject}}</h1>
    </td></tr>
    <tr><td style="padding:0 40px 8px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:16px 0;border-top:1px solid #e5e7eb">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="40" valign="top">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="width:32px;height:32px;background-color:#eff6ff;border-radius:50%;text-align:center;line-height:32px;font-size:14px;font-weight:700;color:{{brand_primary}};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">1</td></tr></table>
            </td>
            <td valign="top" style="padding-left:12px">
              <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#111827;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">First Tip Title</p>
              <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Explain the first tip or best practice here with actionable advice.</p>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:16px 0;border-top:1px solid #e5e7eb">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="40" valign="top">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="width:32px;height:32px;background-color:#eff6ff;border-radius:50%;text-align:center;line-height:32px;font-size:14px;font-weight:700;color:{{brand_primary}};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">2</td></tr></table>
            </td>
            <td valign="top" style="padding-left:12px">
              <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#111827;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Second Tip Title</p>
              <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Provide another practical suggestion your readers can apply right away.</p>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:16px 0;border-top:1px solid #e5e7eb">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="40" valign="top">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="width:32px;height:32px;background-color:#eff6ff;border-radius:50%;text-align:center;line-height:32px;font-size:14px;font-weight:700;color:{{brand_primary}};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">3</td></tr></table>
            </td>
            <td valign="top" style="padding-left:12px">
              <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#111827;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Third Tip Title</p>
              <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Round out the advice with a third powerful tip or strategy.</p>
            </td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:16px 40px 40px;font-size:15px;line-height:1.7;color:#374151;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
      {{content}}
    </td></tr>
  </table>
</td></tr>
<tr><td style="padding:24px 0;text-align:center">
  <p style="margin:0;font-size:12px;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif"><a href="{{preference_url}}" style="color:#9ca3af;text-decoration:underline">Preferences</a> &bull; <a href="{{unsubscribe_url}}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a></p>
</td></tr>`)),

  // 10. Seasonal / Holiday
  makeTemplate('Seasonal / Holiday', 'seasonal', wrapEmail('#f4f4f7', `
<tr><td>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#059669,#047857);background-color:#059669;border-radius:8px 8px 0 0">
    <tr><td style="padding:20px 40px">
      <span style="font-size:16px;font-weight:700;color:#ffffff;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Your Logo</span>
    </td></tr>
    <tr><td style="padding:24px 40px 48px;text-align:center">
      <p style="margin:0 0 8px;font-size:32px;line-height:1">&#10052;&#127873;&#10052;</p>
      <h1 class="hero-text" style="margin:0 0 12px;font-size:30px;font-weight:800;color:#ffffff;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;line-height:1.2">{{subject}}</h1>
      <p style="margin:0;font-size:16px;color:rgba(255,255,255,0.85);line-height:1.6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Celebrate the season with something special.</p>
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{{brand_bg}};border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none">
    <tr><td style="padding:40px;font-size:15px;line-height:1.7;color:#374151;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
      {{content}}
    </td></tr>
    <tr><td style="padding:0 40px 32px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ecfdf5;border-radius:8px;border:1px solid #a7f3d0">
        <tr><td style="padding:20px;text-align:center">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#059669;text-transform:uppercase;letter-spacing:1.5px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Seasonal Offer</p>
          <p style="margin:0 0 16px;font-size:20px;font-weight:800;color:#065f46;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Use code HOLIDAY for a special discount</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr><td class="btn-td" style="background-color:#059669;border-radius:6px;padding:12px 28px">
            <a href="#" style="font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">Claim Offer &rarr;</a>
          </td></tr></table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</td></tr>
<tr><td style="padding:24px 0;text-align:center">
  <p style="margin:0;font-size:12px;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif"><a href="{{preference_url}}" style="color:#9ca3af;text-decoration:underline">Preferences</a> &bull; <a href="{{unsubscribe_url}}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a></p>
</td></tr>`)),
]

const CATEGORY_COLORS: Record<string, string> = {
  newsletter: '#3B82F6',
  announcement: '#1E293B',
  product: '#8B5CF6',
  onboarding: '#F59E0B',
  promotion: '#DC2626',
  event: '#0EA5E9',
  'social-proof': '#10B981',
  educational: '#6366F1',
  seasonal: '#059669',
  general: '#6B7280',
}

async function seedDefaults(knex: ReturnType<EntityManager['getKnex']>, tenantId: string, orgId: string) {
  const crypto = require('crypto')
  const rows = DEFAULT_TEMPLATES.map(t => ({
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    organization_id: orgId,
    name: t.name,
    category: t.category,
    html_template: t.html_template,
    is_default: true,
    created_at: new Date(),
    updated_at: new Date(),
  }))
  await knex('email_style_templates').insert(rows)
}

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    let templates = await knex('email_style_templates')
      .where('organization_id', auth.orgId)
      .orderBy([{ column: 'category' }, { column: 'name' }])

    if (templates.length === 0) {
      await seedDefaults(knex, auth.tenantId!, auth.orgId)
      templates = await knex('email_style_templates')
        .where('organization_id', auth.orgId)
        .orderBy([{ column: 'category' }, { column: 'name' }])
    }

    const data = templates.map((t: Record<string, unknown>) => ({
      ...t,
      categoryColor: CATEGORY_COLORS[t.category as string] || CATEGORY_COLORS.general,
    }))

    return NextResponse.json({ ok: true, data })
  } catch (error) {
    console.error('[email.templates.GET]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load templates' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { name, category, htmlTemplate } = body

    if (!name || !htmlTemplate) {
      return NextResponse.json({ ok: false, error: 'name and htmlTemplate required' }, { status: 400 })
    }

    const crypto = require('crypto')
    const id = crypto.randomUUID()
    await knex('email_style_templates').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      name,
      category: category || 'general',
      html_template: htmlTemplate,
      is_default: false,
      created_by: auth.userId,
      created_at: new Date(),
      updated_at: new Date(),
    })

    return NextResponse.json({ ok: true, data: { id } }, { status: 201 })
  } catch (error) {
    console.error('[email.templates.POST]', error)
    return NextResponse.json({ ok: false, error: 'Failed to create template' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const template = await knex('email_style_templates')
      .where({ id, organization_id: auth.orgId })
      .first()

    if (!template) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
    if (template.is_default) return NextResponse.json({ ok: false, error: 'Cannot delete default templates' }, { status: 403 })

    await knex('email_style_templates').where({ id, organization_id: auth.orgId }).del()
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[email.templates.DELETE]', error)
    return NextResponse.json({ ok: false, error: 'Failed to delete template' }, { status: 500 })
  }
}

export const openApi = {
  tag: 'Email',
  summary: 'Email style templates CRUD',
  methods: ['GET', 'POST', 'DELETE'],
}
