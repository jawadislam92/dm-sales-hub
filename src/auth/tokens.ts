import { createHmac, timingSafeEqual } from 'node:crypto'

// Stateless signed tokens (magic links + sessions). HMAC over a base64url JSON body
// with an expiry, so nothing to store server-side and sessions survive restarts.
const nowSec = (): number => Math.floor(Date.now() / 1000)
const secret = (): string => process.env.SESSION_SECRET || 'dev-insecure-change-me'

export function sign(payload: Record<string, unknown>, ttlSec: number): string {
  const data = Buffer.from(JSON.stringify({ ...payload, exp: nowSec() + ttlSec })).toString('base64url')
  const mac = createHmac('sha256', secret()).update(data).digest('base64url')
  return `${data}.${mac}`
}

export function verify<T = Record<string, unknown>>(token: string): T | null {
  const dot = token.indexOf('.')
  if (dot < 0) return null
  const data = token.slice(0, dot)
  const mac = token.slice(dot + 1)
  const expected = createHmac('sha256', secret()).update(data).digest('base64url')
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const body = JSON.parse(Buffer.from(data, 'base64url').toString()) as { exp?: number }
    if (typeof body.exp !== 'number' || body.exp < nowSec()) return null
    return body as T
  } catch {
    return null
  }
}
