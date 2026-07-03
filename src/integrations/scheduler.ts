import type { PGlite } from '@electric-sql/pglite'
import { runIntegration } from './service'

// In-process scheduler: every tick, run any enabled api_poll integration whose
// interval has elapsed. Non-overlapping. Good for this data volume; a dedicated
// job runner is the scale path (noted for deploy).
export function startScheduler(db: PGlite, tickSeconds = 30, log?: (m: string) => void): () => void {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      const due = (await db.query<{ id: number; interval_seconds: number | null; last_run_at: string | null }>(
        `SELECT id, interval_seconds, last_run_at FROM integrations WHERE enabled = true AND kind = 'api_poll'`)).rows
      const now = Date.now()
      for (const it of due) {
        const iv = (it.interval_seconds || 300) * 1000
        const last = it.last_run_at ? new Date(it.last_run_at).getTime() : 0
        if (now - last < iv) continue
        try {
          const r = await runIntegration(db, it.id)
          log?.(`integration ${it.id}: ${r.stored} new of ${r.fetched}`)
        } catch (e) {
          log?.(`integration ${it.id} failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    } finally {
      running = false
    }
  }, tickSeconds * 1000)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}
