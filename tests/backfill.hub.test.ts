import { describe, it, expect, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { runMigrations } from '../src/db/pglite'
import { backfill } from '../src/backfill/backfill'
import { createPgSource } from '../src/data/pgSource'
import { aggregate } from '../src/engine/metrics'
import type { DataSource } from '../src/data/source'

// Integration proof that the backfill projection (snapshot -> DB -> pgSource) is
// row-faithful: the DB-derived numbers must still reconcile to the HUB. Gated behind
// RUN_DB_TESTS (loads the 17MB snapshot into PGlite) so the fast unit suite stays fast;
// the pure-engine HUB gate in hub.parity.test.ts is the always-on CI gate.
const DATA_DIR = process.env.DATA_DIR ?? 'C:/Users/jawad/Downloads/Pavan/dashboard-build/data'

describe.skipIf(!process.env.RUN_DB_TESTS)('DB-backed HUB parity (backfill -> pgSource -> engine)', () => {
  let source: DataSource
  beforeAll(async () => {
    const db = await PGlite.create()
    await runMigrations(db)
    await backfill(db, DATA_DIR)
    source = await createPgSource(db)
  }, 120000)

  it('June closer cash from the database reconciles to $455,674.90', async () => {
    const A = aggregate(await source.getBK(), 'closer', '2026-06-01', '2026-06-30', 'call')
    expect(A.tot.cash).toBeCloseTo(455674.90, 2)
    const sam = A.map['Sam Aujla']
    expect(sam.shown).toBe(50)
    expect(sam.qual).toBe(43)
    expect(sam.closed).toBe(27)
  })
})
