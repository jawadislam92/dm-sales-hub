// CLI: load the snapshot into the persisted dev database.
//   node node_modules/tsx/dist/cli.mjs src/backfill/run.ts
import { getDb } from '../db/pglite'
import { backfill } from './backfill'
import { env } from '../config/env'

const dir = process.env.PGDATA_DIR ?? './.pgdata'
const db = await getDb(dir)
const res = await backfill(db, env.DATA_DIR)
console.log('backfill complete:', JSON.stringify(res))
process.exit(0)
