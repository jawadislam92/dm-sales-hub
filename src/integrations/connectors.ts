// Generic HTTP poller — covers most REST APIs, including Close.com (Basic auth with
// the API key as the username). A tool-specific connector is just a PollConfig preset.

export interface PollConfig {
  base_url: string
  path?: string
  method?: string
  auth?: { type?: 'bearer' | 'basic' | 'header' | 'none'; header?: string; token?: string }
  result_path?: string // dot-path to the array in the JSON response (e.g. "data")
  headers?: Record<string, string>
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
  const url = (config.base_url || '').replace(/\/$/, '') + (config.path || '')
  const res = await fetch(url, {
    method: config.method || 'GET',
    headers: { accept: 'application/json', ...(config.headers || {}), ...authHeaders(config.auth) },
  })
  if (!res.ok) throw new Error(`poll ${url} -> HTTP ${res.status}`)
  const data = dig(await res.json(), config.result_path)
  if (Array.isArray(data)) return data
  return data == null ? [] : [data]
}
