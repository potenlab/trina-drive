// Team skills, the parts under the gate: SKILL.md frontmatter (agentskills.io rules, the YAML subset), versions and
// editors as the scanner records them, the diff shown to approvers, the zip download, and the CLI
// (`folder flag <path> skills`, `skills list|validate|approve`).
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CLI_COMMANDS, findCommand } from '../src/cli-registry'
import { main } from '../src/cli'
import { approvedOf, libraries, pendingOf, scan, slugFrom } from '../src/skills/core'
import { unifiedDiff } from '../src/skills/diff'
import { checkSkillMd, FrontmatterError, parseFrontmatter } from '../src/skills/frontmatter'
import { crc32, zip } from '../src/skills/zip'
import { setup, type Env } from './helpers'
import { skillMd, writeSkill } from './skills-helpers'

let e: Env | null = null
afterEach(() => { e?.cleanup(); e = null })
const enc = (s: string) => new TextEncoder().encode(s)

describe('SKILL.md frontmatter', () => {
  test('the YAML subset: scalars, quotes, block scalars, a nested map, lists; rendered as JSON verbatim', () => {
    const fm = parseFrontmatter([
      'name: pdf-tools', 'description: "Extract: fill, and \\"assemble\\" PDFs"', "license: 'Apache-2.0'", 'metadata:', '  version: 2.1', '  author: sam',
      'when_to_use: |', '  For PDFs.', '  Not for images.', 'tags: [a, b]', 'paths:', '  - docs/**', '  - "*.pdf"', 'flag: true', '# comment', '',
    ].join('\n'))
    expect(fm).toEqual({ name: 'pdf-tools', description: 'Extract: fill, and "assemble" PDFs', license: 'Apache-2.0', metadata: { version: 2.1, author: 'sam' },
      when_to_use: 'For PDFs.\nNot for images.\n', tags: ['a', 'b'], paths: ['docs/**', '*.pdf'], flag: true })
  })

  test('what is refused: anchors, duplicate keys, deep nesting, unquoted ": "', () => {
    for (const y of ['name: &a x', 'name: a\nname: b', 'metadata:\n  a:\n    b: c', 'description: a: b', 'name: {a: 1}', '  name: x'])
      expect(() => parseFrontmatter(y)).toThrow(FrontmatterError)
  })

  test('agentskills.io rules: name = folder, lowercase-hyphen ≤ 64, description ≤ 1,024, SKILL.md ≤ 256 KB, UTF-8', () => {
    expect(checkSkillMd(enc(skillMd('my-skill', 'Does a thing.')), 'my-skill').name).toBe('my-skill')
    const bad: [string, string, RegExp][] = [
      [skillMd('my-skill', 'x'), 'other', /folder's name/], [skillMd('My_Skill', 'x'), 'My_Skill', /lowercase/], [skillMd('-a', 'x'), '-a', /lowercase/],
      [skillMd('a--b', 'x'), 'a--b', /lowercase/], [skillMd('a'.repeat(65), 'x'), 'a'.repeat(65), /1–64/], [skillMd('a', 'y'.repeat(1025)), 'a', /1024/],
      ['---\nname: a\n---\n', 'a', /description/], ['# no frontmatter', 'a', /frontmatter/], ['---\nname: a\ndescription: x\n', 'a', /closing/],
    ]
    for (const [text, dir, why] of bad) expect(() => checkSkillMd(enc(text), dir)).toThrow(why)
    expect(() => checkSkillMd(new Uint8Array(300 * 1024).fill(97), 'a')).toThrow(/256 KB/)
    expect(() => checkSkillMd(Uint8Array.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe]), 'a')).toThrow(/UTF-8/)
    expect(checkSkillMd(enc(skillMd('a', 'x', 'body\n', 'allowed-tools: Bash\n')), 'a').warnings.join()).toContain('allowed-tools is ignored')
  })

  test('slugs from folder names: plain ASCII only', () => {
    expect(slugFrom('Skills')).toBe('skills')
    expect(slugFrom('Sales Team_Skills')).toBe('sales-team-skills')
    expect(slugFrom('스킬')).toBeNull()
  })
})

describe('the scanner: versions, editors, problems', () => {
  test('a new skill is pending; an edit is a new pending version (the older pending is superseded); back to approved clears it', async () => {
    e = setup()
    const dir = path.join(e.root, '공용', 'Skills')
    writeSkill(dir, 'proposal', 'v1')
    const run = (args: string[]) => findCommand(args)!.command.run({ db: e!.db, dataDir: e!.dir, args: findCommand(args)!.rest, out: () => {}, err: () => {} })
    expect(run(['skills', 'library', dir, '--slug', 'common'])).toBeFalsy()
    const lib = libraries(e.db)[0]!.folder_id
    const v1 = pendingOf(e.db, lib, 'proposal')!
    expect(JSON.parse(v1.editors)).toEqual([null]) // written on the share: who is unknown
    expect(run(['skills', 'approve', 'common/proposal', v1.digest.slice(0, 12), '--by', 'dion'])).toBeFalsy()
    expect(approvedOf(e.db, lib, 'proposal')!.digest).toBe(v1.digest)
    writeSkill(dir, 'proposal', 'v2')
    scan(e.db, e.dir)
    const v2 = pendingOf(e.db, lib, 'proposal')!
    writeSkill(dir, 'proposal', 'v3')
    scan(e.db, e.dir)
    const v3 = pendingOf(e.db, lib, 'proposal')!
    expect(v3.id).not.toBe(v2.id)
    expect(e.db.query<{ status: string }, [number]>('SELECT status FROM skill_versions WHERE id = ?').get(v2.id)!.status).toBe('superseded')
    writeSkill(dir, 'proposal', 'v1')
    scan(e.db, e.dir)
    expect(pendingOf(e.db, lib, 'proposal')).toBeNull()
    // a broken skill is a problem, never a version
    fs.writeFileSync(path.join(dir, 'proposal', 'SKILL.md'), '---\nname: wrong\ndescription: x\n---\n')
    const r = scan(e.db, e.dir)
    expect(r.problems.map((p) => p.error)).toEqual(['name "wrong" must be the folder\'s name ("proposal")'])
    expect(approvedOf(e.db, lib, 'proposal')!.digest).toBe(v1.digest) // still serving the approved one
  })

  test('links inside a skill are never followed; folders without SKILL.md are not skills', () => {
    e = setup()
    const dir = path.join(e.root, '공용', 'Skills')
    writeSkill(dir, 'linky', 'x', { files: { 'ok.md': 'fine' } })
    fs.symlinkSync(path.join(e.root, '경영', '손익.csv'), path.join(dir, 'linky', 'pnl.csv'))
    fs.mkdirSync(path.join(dir, 'not-a-skill'))
    fs.writeFileSync(path.join(dir, 'not-a-skill', 'README.md'), 'x')
    findCommand(['skills', 'library'])!.command.run({ db: e.db, dataDir: e.dir, args: [dir, '--slug', 'common'], out: () => {}, err: () => {} })
    const lib = libraries(e.db)[0]!.folder_id
    expect(JSON.parse(pendingOf(e.db, lib, 'linky')!.manifest).map((f: { path: string }) => f.path)).toEqual(['SKILL.md', 'ok.md'])
    expect(pendingOf(e.db, lib, 'not-a-skill')).toBeNull()
  })
})

describe('diff and zip', () => {
  test('unified diff with context', () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const b = a.replace('line 3\n', 'line three\n').replace('line 15\n', '')
    const d = unifiedDiff(a, b, 'a', 'b')
    expect(d).toContain('--- a\n+++ b\n@@ -1,7 +1,7 @@')
    expect(d).toContain('-line 3\n+line three')
    expect(d).toContain('-line 15')
    expect(unifiedDiff(a, a, 'a', 'b')).toBe('')
    expect(unifiedDiff('', 'x\n', '/dev/null', 'b')).toBe('--- /dev/null\n+++ b\n@@ -0,0 +1,1 @@\n+x')
  })

  test('the zip opens with a standard tool and holds exactly the files', () => {
    expect(crc32(enc('123456789'))).toBe(0xcbf43926)
    const z = zip([{ name: 'proposal/SKILL.md', bytes: enc('# hi\n') }, { name: 'proposal/references/요율.md', bytes: enc('rates') }])
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdrive-zip-'))
    try {
      fs.writeFileSync(path.join(dir, 'a.zip'), z)
      const t = spawnSync('unzip', ['-t', path.join(dir, 'a.zip')], { encoding: 'utf8' })
      if (t.error) return // no unzip here: the CRC test above still holds
      expect(t.status).toBe(0)
      spawnSync('unzip', ['-q', path.join(dir, 'a.zip'), '-d', path.join(dir, 'out')])
      expect(fs.readFileSync(path.join(dir, 'out', 'proposal', 'references', '요율.md'), 'utf8')).toBe('rates')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('CLI', () => {
  test('folder flag <path> skills goes to the skills module; list, validate, approve; the editor rule holds on the CLI', async () => {
    e = setup()
    const dir = path.join(e.root, '공용', 'Skills')
    writeSkill(dir, 'proposal', 'Draft a proposal.')
    const out: string[] = [], err: string[] = []
    const log = console.log, error = console.error
    console.log = (s: string) => { out.push(String(s)) }
    console.error = (s: string) => { err.push(String(s)) }
    try {
      await main(['--data', e.dir, 'folder', 'flag', dir, 'skills', '--slug', 'common', '--by', 'dion'])
      await main(['--data', e.dir, 'folder', 'flag', dir, 'skills', '--slug', 'other', '--by', 'kim'])
    } finally { console.log = log; console.error = error; process.exitCode = 0 }
    expect(out.join('\n')).toContain('is a skill library: skills are "common/<name>" (1 found, 1 waiting for approval)')
    expect(err.join('\n')).toContain('kim is not an admin')
    const lines: string[] = []
    const c = (args: string[]) => { const f = findCommand(args)!; return f.command.run({ db: e!.db, dataDir: e!.dir, args: f.rest, out: (s) => lines.push(s), err: (s) => lines.push(s) }) }
    c(['skills', 'list'])
    expect(lines.join('\n')).toMatch(/common\/proposal\tserving: —\twaiting: pending sha256:/)
    expect(c(['skills', 'validate', path.join(dir, 'proposal')])).toBeFalsy()
    fs.mkdirSync(path.join(e.dir, 'bad-dir'))
    fs.writeFileSync(path.join(e.dir, 'bad-dir', 'SKILL.md'), skillMd('other', 'x'))
    expect(c(['skills', 'validate', path.join(e.dir, 'bad-dir')])).toBe(1)
    const v = pendingOf(e.db, libraries(e.db)[0]!.folder_id, 'proposal')!
    expect(c(['skills', 'approve', 'common/proposal', v.digest, '--by', 'kim'])).toBe(1) // not an admin
    expect(c(['skills', 'approve', 'common/proposal', 'abc', '--by', 'dion'])).toBe(1) // digest too short
    expect(c(['skills', 'approve', 'common/proposal', v.digest, '--by', 'dion'])).toBeFalsy()
    lines.length = 0
    c(['skills', 'list', '--as', 'kim'])
    expect(lines.join('\n')).toContain('common/proposal\t/공용/Skills/proposal')
    lines.length = 0
    c(['skills', 'list', '--as', 'lee'])
    expect(lines.join('\n')).toContain('common/proposal') // lee is in 전체 too
    expect(e.db.query<{ command: string }, []>("SELECT command FROM audit WHERE tool = 'cli'").all().map((r) => r.command))
      .toEqual(['skills library /공용/Skills as "common"', `approve skill common/proposal sha256:${v.digest}`])
    expect(CLI_COMMANDS.filter((x) => x.name.startsWith('skills ')).map((x) => x.name)).toEqual(['skills library', 'skills list', 'skills validate', 'skills approve'])
  })
})
