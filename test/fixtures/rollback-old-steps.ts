// Run by test/file-grants-rollback.test.ts with an OLDER checkout's code (no file sharing) against a data directory the
// new code made: `bun rollback-old-steps.ts <old checkout> <data dir> <names.json>`. Every step must succeed (exit 0)
// although the database holds file_grants, mfiles.uid/location, groups.uid and via_file columns the old code never
// reads. Prints one JSON line with what the new code must check afterwards.
const [oldRoot, dataDir, namesFile] = process.argv.slice(2) as [string, string, string]
const imp = (p: string) => import(`${oldRoot}/src/${p}`)
const { openDb } = await imp('db.ts')
const { makeCtx } = await imp('session.ts')
const { Managed, rescan } = await imp('managed/ops.ts')
const { stageBytes } = await imp('managed/core.ts')
const { Access } = await imp('policy.ts')
const fs = await import('node:fs')
const names = JSON.parse(fs.readFileSync(namesFile, 'utf8')) as { O: number; P1: number; P3: number; G: number; mount: string }
const db = openDb(dataDir)
const ctx = makeCtx(db, dataDir)
const m = () => new Managed(ctx, names.O)
const put = (dir: string, name: string, text: string, conflict = 'fail') => { const mg = m(); return mg.put(dir, name, stageBytes(mg.s.root, Buffer.from(text)), conflict) }
const T = '/' + names.mount
const out: Record<string, unknown> = {}
const step = (name: string, f: () => unknown) => {
  try { out[name] = f() ?? true } catch (e) { console.error(`old image step ${name} failed:`, e); process.exit(1) }
}
step('upload f7', () => put(`${T}/d1`, 'f7.md', 'F7 CANARY-F7'))
step('replace f1', () => put(`${T}/d1`, 'f1.md', 'F1-NEW CANARY-F1-NEW', 'replace'))
step('rename f3', () => m().rename(`${T}/d1/f3.md`, 'f3-renamed.md'))
step('move f3', () => m().move([`${T}/d1/f3-renamed.md`], `${T}/d2`))
step('trash+purge f2', () => { const id = m().removeOne(`${T}/d1/f2.md`); return m().purge(id) })
step('rescan', () => rescan(ctx))
step('delete G, create H with its id', () => {
  db.query('DELETE FROM memberships WHERE group_id = ?').run(names.G)
  db.query('DELETE FROM groups WHERE id = ?').run(names.G)
  db.query("INSERT INTO groups (id, name) VALUES (?, 'H')").run(names.G)
  db.query('INSERT INTO memberships (group_id, person_id) VALUES (?, ?)').run(names.G, names.P3)
})
step('purge f4, upload f8', () => { const id = m().removeOne(`${T}/d2/f4.md`); m().purge(id); return put(`${T}/d2`, 'f8.md', 'F8 CANARY-F8') })
step('P1 cannot open f1 on the old image', () => {
  const e = Access.forPerson(db, names.P1).lookup([names.mount, 'd1', 'f1.md'])
  if (e) { console.error('old image: P1 opened f1'); process.exit(1) }
  return 'hidden'
})
db.close()
console.log(JSON.stringify(out))
