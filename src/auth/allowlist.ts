import type { PGlite } from '@electric-sql/pglite'

export interface AppUser { email: string; role: string }

// Seed admin emails from ALLOWLIST_BOOTSTRAP on boot (idempotent).
export async function bootstrapAdmins(db: PGlite, emails: string[]): Promise<void> {
  for (const raw of emails) {
    const email = raw.trim().toLowerCase()
    if (!email) continue
    await db.query(
      `INSERT INTO users(email, role) VALUES ($1, 'admin')
       ON CONFLICT (email) DO UPDATE SET role = 'admin'`, [email])
  }
}

export async function findUser(db: PGlite, email: string): Promise<AppUser | null> {
  const r = (await db.query<AppUser>(
    'SELECT email, role FROM users WHERE email = $1', [email.trim().toLowerCase()])).rows[0]
  return r ?? null
}
