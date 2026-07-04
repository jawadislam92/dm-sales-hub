// Generic HTTP poller — covers most REST APIs, including Close.com (Basic auth with
// the API key as the username). A tool-specific connector is just a PollConfig preset.

export interface PollConfig {
  base_url: string
  path?: string
  method?: string
  auth?: { type?: 'bearer' | 'basic' | 'header' | 'none'; header?: string; token?: string }
  result_path?: string // dot-path to the array in the JSON response (e.g. "data")
  headers?: Record<string, string>
  // Page through list endpoints (Close uses _skip/_limit + has_more). Auto-enabled
  // for close.com; override the params for other APIs.
  paginate?: { skipParam?: string; limitParam?: string; pageSize?: number; moreField?: string; maxPages?: number }
}

function authHeaders(auth?: PollConfig['auth']): Record<string, string> {
  if (!auth || auth.type === 'none' || !auth.token) return {}
  if (auth.type === 'basic') return { authorization: 'Basic ' + Buffer.from(auth.token + ':').toString('base64') }
  if (auth.type === 'header') return { [auth.header || 'x-api-key']: auth.token }
  return { authorization: 'Bearer ' + auth.token }
}

function dig(obj: unknown, path?: string): unknown {
  if (!path) return obj
  return path.split('.').reduce<unknown>((o, k) => (o == null ? o : (o as Record<string, unknown>)[k]), obj)
}

export async function httpPoll(config: PollConfig): Promise<unknown[]> {
  const base = (config.base_url || '').replace(/\/$/, '') + (config.path || '')
  const method = config.method || 'GET'
  const headers = { accept: 'application/json', ...(config.headers || {}), ...authHeaders(config.auth) }
  const isClose = /(^|\/\/|\.)close\.com/i.test(config.base_url || '')
  const paginate = config.paginate || (isClose ? {} : undefined)

  if (!paginate) {
    const res = await fetch(base, { method, headers })
    if (!res.ok) throw new Error(`poll ${base} -> HTTP ${res.status}`)
    const data = dig(await res.json(), config.result_path)
    return Array.isArray(data) ? data : (data == null ? [] : [data])
  }

  const skipParam = paginate.skipParam || '_skip'
  const limitParam = paginate.limitParam || '_limit'
  const pageSize = paginate.pageSize || 100
  const moreField = paginate.moreField || 'has_more'
  const maxPages = paginate.maxPages || 500
  const out: unknown[] = []
  for (let i = 0, skip = 0; i < maxPages; i++, skip += pageSize) {
    const sep = base.includes('?') ? '&' : '?'
    const res = await fetch(`${base}${sep}${limitParam}=${pageSize}&${skipParam}=${skip}`, { method, headers })
    if (!res.ok) throw new Error(`poll ${base} page ${i} -> HTTP ${res.status}`)
    const body = (await res.json()) as Record<string, unknown>
    const data = dig(body, config.result_path)
    if (Array.isArray(data)) out.push(...data)
    if (!body[moreField] || !Array.isArray(data) || data.length === 0) break
  }
  return out
}
