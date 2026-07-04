import { describe, it, expect } from 'vitest'
import { parseMeetingDate, mapProgram, normalizeLead } from '../src/close/normalize'

describe('Close lead normalization', () => {
  it('parses "Meeting Date and Time" text into YYYY-MM-DD', () => {
    expect(parseMeetingDate('08:00PM - Wednesday, July 1, 2026')).toBe('2026-07-01')
    expect(parseMeetingDate('11:30AM - Monday, December 15, 2025')).toBe('2025-12-15')
    expect(parseMeetingDate('')).toBe('')
    expect(parseMeetingDate('no date here')).toBe('')
  })

  it('maps Funnel to a program bucket', () => {
    expect(mapProgram('DMA')).toBe('DMA')
    expect(mapProgram('DMAP')).toBe('DMAP')
    expect(mapProgram('DMPN')).toBe('DMPN')
  })

  it('normalizes a booked lead, resolving owner id -> name and applying alias', () => {
    const userMap = { user_1: 'Steven Loubser', user_2: 'Richard Daily Mentor' }
    const lead = {
      id: 'lead_x', status_label: 'No-Show', display_name: 'Anshal K',
      custom: {
        'Meeting Date and Time': '08:00PM - Wednesday, July 1, 2026',
        Funnel: 'DMA', 'Lead Owner': 'user_1', 'Lead Country': 'Australia / NZ',
      },
    }
    const b = normalizeLead(lead, userMap)
    expect(b?.scheduled_date).toBe('2026-07-01')
    expect(b?.closer).toBe('Steven Loubser')
    expect(b?.status).toBe('No-Show')
    expect(b?.program).toBe('DMA')

    // placeholder-surname alias resolves to the sheet name
    const b2 = normalizeLead({ ...lead, custom: { ...lead.custom, 'Lead Owner': 'user_2' } }, userMap)
    expect(b2?.closer).toBe('Richard Lee')
  })

  it('skips leads that never booked a call (no meeting date)', () => {
    expect(normalizeLead({ id: 'l', custom: {} }, {})).toBeNull()
  })
})
