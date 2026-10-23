// S48 — a phone (WebKit, 390 px): the console sign-in, the drive's files without sideways scrolling, and the share
// dialog as a bottom sheet (C1).
import type { Scenario } from '../lib/ctx'
import { ui } from '../lib/ui'

export default {
  id: 'S48', title: 'mobile WebKit 390: console sign-in, drive files, share dialog as a bottom sheet', phase: 1, targets: ['local', 'aws'], needs: ['browser', 'webkit'], uses: 'H2',
  async run(t) {
    const r = await (await ui()).mobileWebkit(t)
    t.check('WebKit 390: the console sign-in and the drive render, the files show', r.pagesOk, r)
    t.check('no sideways scrolling', r.overflow.length === 0, r.overflow)
    t.skipPart('the share dialog as a bottom sheet', 'runs in UI1 (C1 web/e2e s48, WebKit 390)')
  },
} satisfies Scenario
