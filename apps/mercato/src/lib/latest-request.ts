/**
 * Search boxes fire a request per keystroke; a slow early response must not
 * overwrite a newer one (QA 2026-09-25 #10: pasting "e2e-imp2" briefly showed
 * all contacts). Each call to `next()` returns a check that stays true only
 * while no later request has started.
 */
export function createLatestRequestGuard() {
  let seq = 0
  return {
    next(): () => boolean {
      const id = ++seq
      return () => id === seq
    },
  }
}
