// S19 (managed) — an AI draft made from /재무 aimed at /프로젝트 (everyone reads it): promote waits for approval (the
// AI cannot approve); a person carrying the same content in by hand is recorded as widening and the source folder's
// Manager hears of it without names (R6/R11, finding 1: A1 re-judges managed copies); widening /프로젝트 later warns.
import type { Scenario } from '../lib/ctx'
import { bash, tool } from '../lib/drive'
import { shareView } from '../lib/share'

export default {
  id: 'S19', title: 'managed re-judging: /재무 draft → /프로젝트 waits for approval; manual copy and later widening are caught', phase: 1, targets: ['local', 'aws'], uses: 'H1 MCP',
  async run(t) {
    const fx = t.fx
    const run = Date.now().toString(36)
    const kim = await fx.drive('kim')
    const tok = await kim.token(`e2e-s19-${run}`, { password: fx.creds('kim').password })
    const read = await bash(t.http, fx.slug, tok, "cat '/재무/결산.md'")
    t.check('kim\'s AI reads /재무', read.stdout.includes('CANARY-FIN'), read)
    await tool(t.http, fx.slug, tok, 'write', { path: `/drafts/s19-${run}.md`, content: `결산 요약 ${run}\n` })
    const pr = await tool(t.http, fx.slug, tok, 'promote', { draft: `/drafts/s19-${run}.md`, folder: '/프로젝트', name: `s19-${run}.md` })
    const link = /#\/approvals\/(\d+)/.exec(pr.text)
    t.check('promote into /프로젝트 → approval pending, nothing written', !!link && (await kim.stat(`/프로젝트/s19-${run}.md`)).status === 404, pr.text)
    const appr = await kim.get('/approvals')
    t.check('the approval is listed for kim (as requester)', appr.status === 200 && appr.text.includes(`s19-${run}`), appr.text.slice(0, 300))
    const notices = await (await fx.drive('admin')).get('/notices')
    t.check('approval notices name no file or folder (R11)', !notices.text.includes(`s19-${run}`) && !/결산/.test(notices.text), notices.text.slice(0, 300))
    if (await t.has('share', 'a hand-made copy is re-judged in managed storage (widened row + source Manager notice, finding 1)')) {
      // the person downloads the AI draft (AI drafts page) and uploads it by hand: the bytes are a tracked draft's
      const drafts = (await kim.get('/drafts')).json().drafts as { id: number; path?: string; name?: string }[]
      const d = drafts.find((x) => (x.path ?? x.name ?? '').includes(`s19-${run}`))
      const bytes = d ? (await kim.get(`/drafts/${d.id}/download`)).text : ''
      const up = await kim.upload('/프로젝트', `s19-copy-${run}.md`, bytes)
      t.check('kim uploads the draft by hand into /프로젝트', !!d && up.status === 200, up.text)
      const v = await shareView(kim, '/프로젝트')
      t.check('the share dialog of /프로젝트 warns about a copy from a folder fewer people see', v.status === 200 && (v.json().warnings ?? []).length > 0, v.text)
    }
  },
} satisfies Scenario
