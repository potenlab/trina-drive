// S24 — what an agent may write (R2, R8): drafts only; never a team folder directly (clear refusal); promote a draft
// that widens nobody → a new file, then a new version; a draft made from what fewer people read → an approval the
// requester cannot grant, which an eligible Manager approves with a second factor.
import type { Scenario } from '../lib/ctx'
import { bash, tool } from '../lib/drive'

export default {
  id: 'S24', title: 'agent writes: drafts yes, team folders no, promote → new file/version, widening → approval (step-up)', phase: 1, targets: ['local', 'aws'], uses: 'H1 MCP',
  async run(t) {
    const fx = t.fx
    const run = Date.now().toString(36)
    const kim = await fx.drive('kim')
    const fresh = await kim.token(`e2e-s24a-${run}`, { password: fx.creds('kim').password }) // no reads yet: no sources
    t.step('drafts yes, originals no')
    const w = await tool(t.http, fx.slug, fresh, 'write', { path: `/drafts/s24-${run}.md`, content: `# plan ${run}\nfrom nothing\n` })
    t.check('write /drafts/… works', !w.isError, w.raw.slice(0, 300))
    const direct = await tool(t.http, fx.slug, fresh, 'write', { path: `/프로젝트/s24-${run}.md`, content: 'direct' })
    t.check('write into /프로젝트 is refused with a message that says drafts', direct.isError && /draft/i.test(direct.text), direct.text)
    const sh = await bash(t.http, fx.slug, fresh, `echo x > '/프로젝트/s24-${run}.md'; echo rc=$?`)
    t.check('bash redirection into /프로젝트 fails: "Originals are read-only. Write to /drafts/"', sh.exit !== 0 && /read-only/i.test(sh.stderr) && /drafts/.test(sh.stderr) && (await kim.stat(`/프로젝트/s24-${run}.md`)).status === 404, sh)
    t.step('promote that widens nobody → a new file, then a new version')
    const p1 = await tool(t.http, fx.slug, fresh, 'promote', { draft: `/drafts/s24-${run}.md`, folder: '/프로젝트', name: `s24-${run}.md` })
    t.check('promote → new file in /프로젝트', !p1.isError && (await kim.download(`/프로젝트/s24-${run}.md`)).text.includes('from nothing'), p1.text)
    await tool(t.http, fx.slug, fresh, 'write', { path: `/drafts/s24-${run}.md`, content: `# plan ${run}\nsecond\n` })
    const p2 = await tool(t.http, fx.slug, fresh, 'promote', { draft: `/drafts/s24-${run}.md`, folder: '/프로젝트', name: `s24-${run}.md`, overwrite: true })
    const vs = await kim.get(`/files/versions?path=${encodeURIComponent(`/프로젝트/s24-${run}.md`)}`)
    t.check('promote overwrite → a new version (the old one kept)', !p2.isError && vs.status === 200 && vs.json().versions.length === 2, p2.text + vs.text.slice(0, 200))
    t.step('a draft from /프로젝트/비밀 into /공용 (more readers) → approval')
    const src = await kim.token(`e2e-s24b-${run}`, { password: fx.creds('kim').password })
    await bash(t.http, fx.slug, src, "cat '/프로젝트/비밀/secret.md'")
    await tool(t.http, fx.slug, src, 'write', { path: `/drafts/s24w-${run}.md`, content: `summary of the secret ${run}\n` })
    const pw = await tool(t.http, fx.slug, src, 'promote', { draft: `/drafts/s24w-${run}.md`, folder: '/공용', name: `s24w-${run}.md`, reason: 'e2e' })
    const link = /#\/approvals\/(\d+)/.exec(pw.text)
    t.check('nothing written; an approval link instead', !!link && (await kim.stat(`/공용/s24w-${run}.md`)).status === 404, pw.text)
    const id = Number(link?.[1] ?? 0)
    const ap = await kim.get(`/approvals/${id}`)
    const sha = ap.status === 200 ? ap.json().sha256 ?? ap.json().approval?.sha256 : undefined
    // kim manages /프로젝트 and so its /비밀 (every source): R8 lets such a requester approve — with a second factor only
    const self = await kim.api('POST', `/approvals/${id}/approve`, { sha256: sha })
    t.check('kim cannot approve without a step-up (403 step_up_required)', self.status === 403 && /step_up/.test(self.text), self.text)
    const noFactor = await kim.api('POST', `/approvals/${id}/step-up`, { sha256: sha, code: '000000' })
    t.check('…and has no second factor to step up with (400 step_up_unavailable)', noFactor.status === 400 && /step_up_unavailable/.test(noFactor.text), noFactor.text)
    const boss = await fx.drive('boss')
    const bv = await boss.get(`/approvals/${id}`)
    const noStep = await boss.api('POST', `/approvals/${id}/approve`, { sha256: bv.json().sha256 ?? bv.json().approval?.sha256 })
    t.check('boss (reads the source, manages /공용) approves only with a step-up: 403 without', noStep.status === 403, noStep.text)
    const a = await fx.approve('boss', id)
    t.check(`boss approves with a ${bv.json().step_up?.method ?? bv.json().step_up?.missing ?? 'second factor'} step-up → the file lands in /공용`, a.step.status === 200 && a.approve.status === 200 && (await boss.stat(`/공용/s24w-${run}.md`)).status === 200, `${a.step.text} ${a.approve.text}`)
  },
} satisfies Scenario
