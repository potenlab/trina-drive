import { chromium } from 'playwright-core'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
const { S, R } = process.env, HOST = 'files.office.lan', BASE = `http://${HOST}:8793`, RAW = `${S}/raw`
fs.mkdirSync(RAW, { recursive: true })
const env = Object.fromEntries(fs.readFileSync(`${S}/d4.env`, 'utf8').trim().split('\n').map((l) => l.split('=')))
const exe = process.env.CHROME // a Chromium or Chrome binary
const b = await chromium.launch({ executablePath: exe, headless: true, args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] })
const mk = () => b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'en-US' })
const PW = 'correct-horse-battery-1'
const api = (page, method, path, body) => page.evaluate(async ([method, path, body]) => {
  const s = await (await fetch('/api/session')).json()
  const r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': s.csrf }, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}, [method, path, body])
const settle = (p) => p.waitForTimeout(900)

// admin: first setup through the setup-token form
const admin = await (await mk()).newPage()
await admin.goto(BASE + '/'); await settle(admin)
const inputs = admin.locator('form input')
await inputs.nth(0).fill(env.SETUP); await inputs.nth(1).fill('alex'); await inputs.nth(2).fill('alex@example.com'); await inputs.nth(3).fill(PW)
await admin.locator('form button').click(); await settle(admin)
const folders = (await api(admin, 'GET', '/folders')).folders
const fid = (v) => folders.find((f) => f.vpath === v).id
await api(admin, 'PUT', `/folders/${fid('/shared')}/promote`, { enabled: true })
const people = (await api(admin, 'GET', '/people')).people
const pages = {}
for (const name of ['mina', 'sam']) {
  const id = people.find((p) => p.name === name).id
  const url = (await api(admin, 'POST', `/people/${id}/invite`, { email: `${name}@example.com` })).invite_url
  const p = await (await mk()).newPage()
  await p.goto(url); await settle(p)
  const pw = p.locator('input[type=password]')
  for (let i = 0; i < await pw.count(); i++) await pw.nth(i).fill(PW)
  await p.locator('form button').click(); await settle(p)
  pages[name] = p
}
// Sam's agent drafts a Q3 summary from /finance and asks to put it in /shared (widening: needs approval)
const mcp = (tok, tool, args) => execSync(`bun ${R}/docs/assets/src/mcp-call.ts ${BASE.replace(HOST, '127.0.0.1')} ${tok} ${tool} '${JSON.stringify(args)}' || true`, { encoding: 'utf8' })
console.log(mcp(env.SAM, 'write', { path: '/drafts/q3-summary.md', content: '# Q3 in one paragraph\n\nRevenue USD 1.42M, up 8.4% on Q2, driven by two new retainer clients from August.\n' }))
console.log(mcp(env.SAM, 'promote', { draft: '/drafts/q3-summary.md', folder: '/shared', name: 'q3-summary.md', reason: 'Q3 summary for Friday’s all-hands' }))
await admin.goto(BASE + '/#/approvals'); await settle(admin)
const approvals = await api(admin, 'GET', '/approvals'); fs.writeFileSync(`${S}/approvals.json`, JSON.stringify(approvals, null, 1))

// 1. Files: admin in /finance with the board memo selected (detail panel: who can see)
await admin.goto(BASE + '/#/files?p=/finance'); await settle(admin)
await admin.locator('text=board-memo-Q3.pdf').click(); await settle(admin)
await admin.screenshot({ path: `${RAW}/files.png` })
// 2. Folder rules: the "Who can see" card of /finance
await admin.goto(BASE + `/#/folders/${fid('/finance')}`); await settle(admin)
await admin.locator('.card', { hasText: 'Who can see' }).first().screenshot({ path: `${RAW}/folder-access.png` })
// 3. Mina: My tokens (connect snippets)
const mina = pages.mina
await mina.goto(BASE + '/#/tokens'); await settle(mina)
await mina.screenshot({ path: `${RAW}/tokens.png` })
// 4. Approvals inbox (admin) and the request
await admin.goto(BASE + '/#/approvals'); await settle(admin)
await admin.screenshot({ path: `${RAW}/approvals-list.png` })
await admin.locator('main a', { hasText: 'q3-summary' }).first().click().catch(() => {}); await settle(admin)
await admin.screenshot({ path: `${RAW}/approval.png`, fullPage: true })
// 5. Mina searches inside every file she may read
await mina.goto(BASE + '/#/files?q=termination%20fee'); await settle(mina)
await mina.screenshot({ path: `${RAW}/search.png` })
await mina.goto(BASE + '/#/drafts'); await settle(mina)
await mina.screenshot({ path: `${RAW}/drafts.png` })
// 6. Audit: what agents read in folders alex manages
await admin.goto(BASE + '/#/audit'); await settle(admin)
await admin.locator('text=My folders').click().catch(() => {}); await settle(admin)
await admin.screenshot({ path: `${RAW}/audit.png` })
await admin.locator('text=Summary').click().catch(() => {}); await settle(admin)
await admin.screenshot({ path: `${RAW}/audit-summary.png` })
await b.close()
