// UI1 — the drive UI scenarios C1 wrote (web/e2e/run.mjs: S10 files, S12 share to a group, S15 roles/O1 in the share
// dialog, S37 screens light/dark × 1440/390, S48 WebKit 390, and the cloud (SSO-only) shell), run by node against
// their own fixture servers with a fresh build of web/. Every `ok`/`FAIL` line is a check here.
import fs from 'node:fs'
import path from 'node:path'
import type { Scenario } from '../lib/ctx'
import { UI_DIR } from '../lib/features'

const ROOT = path.resolve(import.meta.dir, '../../../..')

function newest(dir: string): number {
  let t = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs)
  }
  return t
}

export default {
  id: 'UI1', title: 'drive UI suite (C1 web/e2e): S10 S12 S15 S37 S48 + cloud shell, Chromium/WebKit', phase: 1, targets: ['local'], needs: ['browser', 'webkit'], uses: 'H2',
  async run(t) {
    if (!fs.existsSync(path.join(ROOT, 'web/e2e/run.mjs'))) t.skip('web/e2e/run.mjs is not in this checkout (C1)')
    const dist = path.join(ROOT, 'web/dist/index.html')
    if (!fs.existsSync(dist) || fs.statSync(dist).mtimeMs < newest(path.join(ROOT, 'web/src'))) {
      t.step('bun run build:web')
      const b = Bun.spawnSync(['bun', 'run', 'build:web'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
      t.check('the web app builds', b.exitCode === 0, b.stderr.toString().slice(-400))
    }
    const { playwrightCore } = await import(path.join(UI_DIR, 'browser.ts'))
    const ids = (process.env.E2E_UI1 ?? '').split(/[ ,]+/).filter(Boolean)
    const p = Bun.spawn(['node', 'web/e2e/run.mjs', ...ids], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, PLAYWRIGHT_CORE: playwrightCore(), E2E_OUT: path.join(UI_DIR, '.out', 'web-e2e') } })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    const code = await p.exited
    let n = 0
    for (const line of out.split('\n')) {
      const ok = /^\s*ok\s+(.*)$/.exec(line), bad = /^\s*FAIL\s+(.*)$/.exec(line)
      if (ok) { n++; t.check(ok[1]!.trim(), true) } else if (bad) { n++; t.check(bad[1]!.trim(), false) }
    }
    t.check(`web/e2e/run.mjs finished (exit ${code}, ${n} checks)`, code === 0 && n > 0, (err || out).slice(-600))
  },
} satisfies Scenario
