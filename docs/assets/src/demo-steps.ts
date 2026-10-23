// Runs the README demo against a seeded data directory and saves the real output of every step to a JSON file,
// which terminal.html then types out frame by frame for demo.gif. Nothing in the output is edited.
// Usage: bun docs/assets/src/demo-steps.ts <data-dir> <server-url> <mina-token> <sam-token> <out.json>
import path from 'node:path'

const [data, server, MINA, SAM, out] = process.argv.slice(2)
if (!out) throw new Error('usage: demo-steps.ts <data-dir> <server-url> <mina-token> <sam-token> <out.json>')
const repo = path.resolve(import.meta.dir, '../../..')
const tokens: Record<string, string> = { $MINA: MINA!, $SAM: SAM! }

type Step = { note?: string; show: string; run: string[] }
const sh = (who: '$MINA' | '$SAM', cmd: string): Step => ({
  show: `tdrive sh --token ${who} -c '${cmd}'`,
  run: ['bun', 'run', `${repo}/src/cli.ts`, '--data', data!, 'sh', '--token', tokens[who]!, '-c', cmd],
})
const draft = { path: '/drafts/termination-fees.md', content: 'Acme 36k (12.3) · Globex 12k (14.1) · Northwind 10% (9.2)\n' }

const steps: Step[] = [
  { note: 'Mina is in Sales, Sam is in Finance. Same server, same folders; each AI sees only what its person may.', ...sh('$MINA', 'ls /') },
  sh('$SAM', 'ls /'),
  { note: 'A folder you may not read looks exactly like one that does not exist:', ...sh('$MINA', 'cat /finance/2026-Q3-close.xlsx') },
  { note: 'Sam may. PDFs, Word and Excel files are read as text:', ...sh('$SAM', 'cat /finance/board-memo-Q3.pdf') },
  { note: 'Search inside every contract at once:', ...sh('$MINA', 'grep -ri "termination fee" /contracts') },
  { note: 'Through Trina Drive, originals are read-only:', ...sh('$MINA', 'echo note >> /contracts/acme-supply-2026.pdf') },
  {
    note: 'AI writes drafts instead, and each draft remembers its sources (over MCP, as Claude Code or Codex do):',
    show: `mcp-call $MINA write '${JSON.stringify(draft).replace(/\\n/g, '\\n')}'`,
    run: ['bun', `${repo}/docs/assets/src/mcp-call.ts`, server!, MINA!, 'write', JSON.stringify(draft)],
  },
  { note: 'Every call is in a hash-chained audit log:', show: 'tdrive audit verify', run: ['bun', 'run', `${repo}/src/cli.ts`, '--data', data!, 'audit', 'verify'] },
]

const results = steps.map((s) => {
  const r = Bun.spawnSync(s.run, { stdout: 'pipe', stderr: 'pipe' })
  const res = { note: s.note, cmd: s.show, stdout: r.stdout.toString(), stderr: r.stderr.toString(), exit: r.exitCode }
  process.stdout.write(`$ ${res.cmd}\n${res.stdout}${res.stderr}[exit ${res.exit}]\n`)
  return res
})
await Bun.write(out, JSON.stringify(results, null, 2))
