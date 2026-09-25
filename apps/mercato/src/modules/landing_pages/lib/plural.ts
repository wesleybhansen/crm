/** "1 page", "2 pages". Pass the plural form when it isn't just + "s". */
export function plural(count: number, singular: string, pluralForm?: string): string {
  const n = Number.isFinite(count) ? count : 0
  return `${n.toLocaleString()} ${n === 1 ? singular : (pluralForm ?? `${singular}s`)}`
}
