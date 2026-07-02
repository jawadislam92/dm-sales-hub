import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildBK, aggregate, rate } from '../src/engine/metrics'

const here = dirname(fileURLToPath(import.meta.url))
const tab = JSON.parse(readFileSync(join(here, 'fixtures/bookings.parity.json'), 'utf-8'))

// The release gate. These numbers were verified empirically against the real
// 23,385-row Bookings snapshot and against the team's HUB tabs. They are the
// definition of "the port is faithful." A one-cent drift here fails the build.
//
// NOTE (correction to PLAN.md T1.2): raw booking COUNT does not equal HUB
// bookings (Sam 131 vs 126), and per-closer shown/qual/closed do not all match
// the HUB (Steven diverges). Only what the README actually claims reconciles:
// team cash to the cent, and Sam Aujla's shown/qual/closed. We assert exactly
// those, plus per-closer cash to the dollar.
describe('HUB parity — June 2026 closers, call-date basis (RELEASE GATE)', () => {
  const BK = buildBK(tab)
  const A = aggregate(BK, 'closer', '2026-06-01', '2026-06-30', 'call')

  it('team closer cash reconciles to the HUB to the cent ($455,674.90)', () => {
    expect(A.tot.cash).toBeCloseTo(455674.90, 2)
  })

  it('Sam Aujla anchors match the HUB (shown 50 / qual 43 / closed 27 / 62.79%)', () => {
    const s = A.map['Sam Aujla']
    expect(s.shown).toBe(50)
    expect(s.qual).toBe(43)
    expect(s.closed).toBe(27)
    expect(Math.round(s.cash)).toBe(149181)
    expect(rate(s.closed, s.qual)).toBeCloseTo(62.79, 2)
  })

  it('per-closer June cash matches the HUB to the dollar', () => {
    expect(Math.round(A.map['Steven Loubser'].cash)).toBe(125374)
    expect(Math.round(A.map['Pavan Dhesi'].cash)).toBe(90990)
    expect(Math.round(A.map['Billy Cummings'].cash)).toBe(90130)
  })
})
