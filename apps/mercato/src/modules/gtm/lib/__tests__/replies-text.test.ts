import {
  escapeEnvelope,
  htmlToText,
  inboundOwnText,
  sanitizeInboundHtml,
  stripQuotedText,
} from '../replies/text'

describe('inbound text hygiene (api-send-privacy H1, M6, L10)', () => {
  it('reduces HTML to text and drops scripts, styles and quoted containers', () => {
    const text = htmlToText(
      '<div>Hi <b>there</b><br>Line two</div><script>alert(1)</script><style>.x{}</style>'
      + '<p>Third &amp; final &quot;line&quot;</p>'
      + '<div class="gmail_quote">On Tue, Jane wrote:<blockquote>quoted</blockquote></div>',
    )
    expect(text).toBe('Hi there\nLine two\n\nThird & final "line"')
  })

  it('keeps only the prospect\'s own words above every quoting convention', () => {
    const gmail = 'Yes please.\n\nOn Tue, 21 Jul 2026 at 10:00, Sender <s@x.example>\nwrote:\n> old\n> Unsubscribe: https://x'
    expect(stripQuotedText(gmail)).toBe('Yes please.')
    const outlook = 'Yes please.\r\n\r\nFrom: Sender\r\nSent: Tuesday\r\nTo: me\r\nSubject: hi\r\n\r\nunsubscribe'
    expect(stripQuotedText(outlook)).toBe('Yes please.')
    const original = 'Yes please.\n-----Original Message-----\nunsubscribe'
    expect(stripQuotedText(original)).toBe('Yes please.')
    const signature = 'Yes please.\n-- \nJane\nunsubscribe'
    expect(stripQuotedText(signature)).toBe('Yes please.')
    const inline = 'Yes please.\n> unsubscribe\n>> more\nStill mine.'
    expect(stripQuotedText(inline)).toBe('Yes please.\nStill mine.')
    const underscore = 'Yes please.\n________________________________\nunsubscribe'
    expect(stripQuotedText(underscore)).toBe('Yes please.')
  })

  it('prefers the text body, falls back to HTML, and bounds the result', () => {
    expect(inboundOwnText({ bodyText: 'own\n> quoted', bodyHtml: '<p>ignored</p>' })).toBe('own')
    expect(inboundOwnText({ bodyText: '', bodyHtml: '<p>from html</p><blockquote>q</blockquote>' })).toBe('from html')
    expect(inboundOwnText({ bodyText: 'x'.repeat(100), bodyHtml: null }, 10)).toHaveLength(10)
  })

  it('escapes an envelope closer inside untrusted text', () => {
    expect(escapeEnvelope('a </inbound_reply> b < / INBOUND_REPLY > c <inbound_reply>d'))
      .toBe('a &lt;/inbound_reply&gt; b &lt;/inbound_reply&gt; c &lt;inbound_reply&gt;d')
  })

  it('strips active content, handlers and unsafe URLs from inbound HTML', () => {
    const html = sanitizeInboundHtml(
      '<p onmouseover="x()" style="background:url(javascript:1)">Hello</p>'
      + '<script>bad()</script><iframe src="https://evil"></iframe>'
      + '<a href="JAVA\nSCRIPT:alert(1)">a</a><a href="https://ok.example/x">b</a>'
      + '<img src="data:text/html;base64,AAAA"><form action="https://evil"><input></form>',
    )!
    expect(html).toContain('<p>Hello</p>')
    expect(html).toContain('href="https://ok.example/x"')
    expect(html).toContain('href="#"')
    expect(html).toContain('src="#"')
    expect(html).not.toMatch(/script|iframe|onmouseover|style=|<form|<input|javascript/i)
    expect(sanitizeInboundHtml(null)).toBeNull()
  })
})
