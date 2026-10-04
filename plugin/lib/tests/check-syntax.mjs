import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Uses inherited stdio: portable on Windows and confined runners; no shell required.
const root = fileURLToPath(new URL('../', import.meta.url))
let count = 0
function check(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) check(file)
    else if (/\.(?:js|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
      if (result.error) throw result.error
      if (result.status !== 0) process.exit(result.status ?? 1)
      count++
    }
  }
}
check(root)
console.log(`Syntax checked ${count} JavaScript modules`)
