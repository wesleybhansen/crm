'use client'

import { useEffect, useState } from 'react'

/**
 * Selectors for "something modal is open": Radix/shadcn dialogs and sheets,
 * anything marked aria-modal, and the app's hand-built drawers and modals,
 * which all use a full-screen `fixed inset-0` backdrop.
 */
export const OPEN_OVERLAY_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[aria-modal="true"]',
  '.fixed.inset-0',
].join(', ')

/** Marks elements that belong to the Scout widget itself, so it never hides because of its own panel. */
export const SCOUT_WIDGET_ATTR = 'data-scout-widget'

function isShown(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true
  if (el.hidden) return false
  const style = typeof window !== 'undefined' ? window.getComputedStyle(el) : null
  if (!style) return true
  return style.display !== 'none' && style.visibility !== 'hidden'
}

/** True when a modal dialog, drawer or full-screen overlay (other than Scout's own) is on screen. */
export function hasOpenOverlay(root: ParentNode = document): boolean {
  const candidates = root.querySelectorAll(OPEN_OVERLAY_SELECTOR)
  for (const el of Array.from(candidates)) {
    if (el.closest(`[${SCOUT_WIDGET_ATTR}]`)) continue
    if (isShown(el)) return true
  }
  return false
}

/**
 * Watches the page for open drawers and dialogs. The floating Scout button
 * hides while one is open so it never sits on top of the drawer's own
 * buttons (for example "Create Automation" in the bottom-right corner).
 */
export function useOverlayOpen(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return
    let frame = 0
    const check = () => {
      frame = 0
      setOpen(hasOpenOverlay())
    }
    const schedule = () => {
      if (frame) return
      frame = window.requestAnimationFrame(check)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'data-state', 'aria-modal'],
    })
    check()
    return () => {
      observer.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [])
  return open
}
