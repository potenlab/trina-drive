// S48 — a phone (WebKit, 390 px): the console sign-in, the drive's files without sideways scrolling, and the share
// dialog as a bottom sheet (C1).
import type { Scenario } from '../lib/ctx'
import { ui } from '../lib/ui'

export default {
  id: 'S48', title: 'mobile WebKit 390: console sign-in, drive files, share dialog as a bottom sheet', phase: 1, targets: ['local', 'aws'], needs: ['browser', 'webkit'], uses: 'H2',
  async run(t) {
    const r = await (await ui()).mobileWebkit(t)
    t.check('WebKit 390: console sign-in and the drive render, the files show, nothing wider than the screen', r.ok || (!r.overflow.length && !!r.sheet && !/not a bottom sheet/.test(r.sheet)), r)
    t.check('no sideways scrolling', r.overflow.length === 0, r.overflow)
    if (r.sheet && !/not a bottom sheet|Error|Timeout/i.test(r.sheet)) t.pending('the share dialog as a bottom sheet', r.sheet)
    else t.check('the share dialog is a bottom sheet on the phone', !r.sheet, r.sheet)
    if (!(await t.features.get('sso')).ok) t.pending('the S02/S03 sign-in flows on the phone', 'needs B1+D1 (SSO)')
  },
} satisfies Scenario
