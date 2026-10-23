#!/usr/bin/env node
/**
 * uni-hmr entry point.
 *
 * It only forwards the arguments and provides a top-level error fallback, the
 * business logic lives in src/cli.mjs.
 */
import { run } from '../src/cli.mjs'

run(process.argv.slice(2)).catch((err) => {
  console.error(`[uni-hmr] ${err && err.message ? err.message : err}`)
  if (process.env.UNI_HMR_DEBUG && err && err.stack) console.error(err.stack)
  process.exit(1)
})
