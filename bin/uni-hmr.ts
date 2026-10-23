#!/usr/bin/env node
import { run } from '../src/cli'

try {
  await run(process.argv.slice(2))
} catch (e) {
  console.error(`[uni-hmr] ${(e as Error).message}`)
  if (process.env.UNI_HMR_DEBUG) console.error((e as Error).stack)
  process.exit(1)
}
