/**
 * Minimal quote-aware CSV/TSV line splitting for the contact import flows.
 * A naive split(/[,\t]/) shifts every column after a quoted value like
 * "Acme, Inc." — exactly the kind of cell real HubSpot/GHL/Sheets exports
 * contain — silently importing wrong data. RFC-4180-ish: supports quoted
 * fields, escaped quotes ("") inside them, and comma or tab delimiters.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } // escaped quote
        else inQuotes = false
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',' || ch === '\t') {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}
