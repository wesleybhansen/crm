/**
 * @jest-environment jsdom
 */
import { hasOpenOverlay, SCOUT_WIDGET_ATTR } from '../overlayDetection'

describe('hasOpenOverlay', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('is false on a plain page', () => {
    document.body.innerHTML = '<main><button>Save</button></main>'
    expect(hasOpenOverlay()).toBe(false)
  })

  it('sees a hand-built drawer backdrop', () => {
    document.body.innerHTML = '<div class="fixed inset-0 z-40 bg-black/30"></div><div class="fixed top-0 right-0">Drawer</div>'
    expect(hasOpenOverlay()).toBe(true)
  })

  it('sees an open Radix dialog and aria-modal dialogs', () => {
    document.body.innerHTML = '<div role="dialog" data-state="open">x</div>'
    expect(hasOpenOverlay()).toBe(true)
    document.body.innerHTML = '<div role="dialog" aria-modal="true">x</div>'
    expect(hasOpenOverlay()).toBe(true)
  })

  it('ignores closed or hidden overlays and Scout itself', () => {
    document.body.innerHTML = '<div role="dialog" data-state="closed">x</div><div class="fixed inset-0" style="display:none"></div>'
    expect(hasOpenOverlay()).toBe(false)
    document.body.innerHTML = `<div ${SCOUT_WIDGET_ATTR}><div class="fixed inset-0"></div></div>`
    expect(hasOpenOverlay()).toBe(false)
  })
})
