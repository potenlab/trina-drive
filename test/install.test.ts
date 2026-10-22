// Runs the installer's dry-run test (test/install-dryrun.sh): no root, nothing outside a temporary folder.
import { expect, test } from 'bun:test'
import path from 'node:path'

test.skipIf(process.platform !== 'darwin')('install-macos.sh --dry-run --prefix', () => {
  const p = Bun.spawnSync(['/bin/bash', path.join(import.meta.dir, 'install-dryrun.sh')], { stdout: 'pipe', stderr: 'pipe' })
  const out = p.stdout.toString() + p.stderr.toString()
  if (p.exitCode !== 0) console.log(out.split('\n').filter((l) => !l.startsWith('ok ')).join('\n'))
  expect(p.exitCode).toBe(0)
  expect(out).toContain('all checks passed')
}, 180_000)
