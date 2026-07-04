// Turn a Close lead into a normalized booking. A "booking" = a lead that booked
// a call, i.e. has a "Meeting Date and Time". Setter + cash come from Jotform/
// payments later — not present on the Close lead.

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

// "08:00PM - Wednesday, July 1, 2026" -> "2026-07-01"
export function parseMeetingDate(s: string): string {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(s || '')
  if (!m) return ''
  const mo = MONTHS[m[1].toLowerCase()]
  if (!mo) return ''
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`
}

export function mapProgram(funnel: string): string {
  const f = (funnel || '').toUpperCase()
  if (f.includes('DMAP') || f.includes('PLUS')) return 'DMAP'
  if (f.includes('DMA')) return 'DMA'
  if (f.includes('DMPN') || f.includes('PN')) return 'DMPN'
  return funnel || ''
}

// Close users with a placeholder surname -> their real (sheet) name.
const DISPLAY_ALIAS: Record<string, string> = {
  'Richard Daily Mentor': 'Richard Lee',
  'Emilia Daily Mentor': 'Emilia de Azcuenaga',
}

export interface CloseBooking {
  lead_id: string
  status: string
  program: string
  scheduled_date: string
  closer: string
  prospect: string
  country: string
  date_created: string
}

export function normalizeLead(
  lead: Record<string, unknown>, userMap: Record<string, string>,
): CloseBooking | null {
  const custom = (lead.custom || {}) as Record<string, unknown>
  const scheduled = parseMeetingDate(String(custom['Meeting Date and Time'] || ''))
  if (!scheduled) return null // never booked a call — not a booking
  const rawName = userMap[String(custom['Lead Owner'] || '')] || ''
  return {
    lead_id: String(lead.id || ''),
    status: String(lead.status_label || ''),
    program: mapProgram(String(custom['Funnel'] || '')),
    scheduled_date: scheduled,
    closer: DISPLAY_ALIAS[rawName] || rawName,
    prospect: String(lead.display_name || ''),
    country: String(custom['Lead Country'] || ''),
    date_created: String(lead.date_created || '').slice(0, 10),
  }
}
