// VERBATIM PORT of the date helpers from dashboard.template.html (lines 185-190).
// UTC-anchored string math on 'YYYY-MM-DD' — never a locale/tz-shifted Date.
// Ported unchanged so hosted numbers equal the prototype and the HUB.

const parseD = (s: string): Date => new Date(s + 'T00:00:00Z')
const isoD = (d: Date): string => d.toISOString().slice(0, 10)

export const addDays = (s: string, n: number): string => {
  const d = parseD(s)
  d.setUTCDate(d.getUTCDate() + n)
  return isoD(d)
}

export const daysBetween = (a: string, b: string): number =>
  Math.round((parseD(b).getTime() - parseD(a).getTime()) / 864e5)

export const monthStart = (s: string): string => s.slice(0, 7) + '-01'

export const monthEnd = (s: string): string => {
  const d = parseD(s.slice(0, 7) + '-01')
  d.setUTCMonth(d.getUTCMonth() + 1)
  d.setUTCDate(0)
  return isoD(d)
}
