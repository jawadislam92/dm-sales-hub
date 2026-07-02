// Regenerates tests/fixtures/bookings.parity.json from the prototype snapshot.
// Keeps ONLY the 7 columns the metric engine reads (rep names, status, dates,
// cash) — no customer PII. The fixture is git-ignored; run this to (re)create it.
//
//   node tools/gen-parity-fixture.mjs [path-to-site_data.json]
//
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = process.argv[2] || process.env.SNAPSHOT ||
  'C:/Users/jawad/Downloads/Pavan/dashboard-build/data/site_data.json'
const out = resolve(here, '../tests/fixtures/bookings.parity.json')

const NAMES = [
  'Booking Date', 'Scheduled Call Date (PST)', 'Lead Owner',
  'Attributed Setter Full Name', 'Lead Status',
  'Total Cash Collected', 'Total Cash Collected after Fees',
]

const data = JSON.parse(readFileSync(src, 'utf-8'))
const B = data.tabs.find((t) => t.name === 'Bookings')
if (!B) throw new Error('Bookings tab not found in ' + src)
const idx = Object.fromEntries(B.cols.map((c, i) => [String(c).trim().toLowerCase(), i]))
const ii = NAMES.map((n) => idx[n.trim().toLowerCase()])
if (ii.some((i) => i === undefined)) throw new Error('a required Bookings column is missing')
const rows = B.data.map((r) => ii.map((i) => r[i]))

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ name: 'Bookings', cols: NAMES, data: rows }))
console.log(`wrote ${rows.length} rows -> ${out}`)
