import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Local dev database = embedded Postgres (PGlite), zero install, real Postgres SQL.
// In prod the same migrations run against a real Postgres via a pg pool; the query
// shapes are identical, so nothing above this layer changes.

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations')

export async function runMigrations(db: PGlite): Promise<void> {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) await db.exec(readFileSync(join(migrationsDir, f), 'utf-8'))
}

let singleton: PGlite | null = null

// dataDir omitted -> in-memory (tests). Given -> persisted to disk (dev server).
export async function getDb(dataDir?: string): Promise<PGlite> {
  if (singleton) return singleton
  singleton = dataDir ? await PGlite.create(dataDir) : await PGlite.create()
  await runMigrations(singleton)
  return singleton
}
