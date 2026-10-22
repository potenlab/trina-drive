// The `bash` tool: just-bash over the VirtualFs, grep/rg on ripgrep, per-command read modes, limits and output caps.
// just-bash runs in this process (no isolated executor yet): the deadline is cooperative plus ripgrep's own kill.
import { Bash, defineCommand, type Command } from 'just-bash'
import { LIMITS, NAME } from './config'
import { grepCommands } from './grep'
import type { Session } from './session'
import { commandMode, FsError, VirtualFs, type Mode } from './vfs'
import { runShellIsolated } from './worker'

export interface ShellResult { stdout: string; stderr: string; exitCode: number }

const bytesOnly = (args: string[]) => args.some((a) => a === '-c' || a === '--bytes' || /^-[a-z]*c/.test(a)) && !args.some((a) => /^-[a-z]*[lwmL]/.test(a) || ['--lines', '--words', '--chars'].includes(a))

/** Commands that see original bytes (raw) and/or only count/compare (weak provenance). Everything else: text, strong. */
export const MODES: Record<string, (args: string[]) => Mode> = {
  sha256sum: () => ({ raw: true, weak: true }),
  sha1sum: () => ({ raw: true, weak: true }),
  md5sum: () => ({ raw: true, weak: true }),
  file: () => ({ raw: true, weak: true }),
  od: () => ({ raw: true, weak: false }),
  base64: () => ({ raw: true, weak: false }),
  strings: () => ({ raw: true, weak: false }),
  gzip: () => ({ raw: true, weak: false }),
  zcat: () => ({ raw: true, weak: false }),
  gunzip: () => ({ raw: true, weak: false }),
  tar: () => ({ raw: true, weak: false }),
  wc: (a) => ({ raw: bytesOnly(a), weak: true }),
  diff: (a) => ({ raw: false, weak: a.includes('-q') || a.includes('--brief') }),
}

const modeWrappers = (): Command[] => Object.entries(MODES).map(([name, mode]) =>
  defineCommand(name, (args, ctx) => commandMode.run(mode(args), () => ctx.origCommand!(args))))

function cap(s: string, max: number, what: string): string {
  const b = Buffer.from(s)
  if (b.length <= max) return s
  return new TextDecoder().decode(b.subarray(0, max)).replace(/�$/, '') + `\n[${what} truncated at ${Math.round(max / 1024)} KB]\n`
}

/** Shell commands run in an isolated worker (sandbox-exec / bwrap) unless SHELF_SHELL=inprocess (development and tests only). */
export function shellMode(): 'isolated' | 'inprocess' {
  return process.env.SHELF_SHELL === 'inprocess' ? 'inprocess' : 'isolated'
}

export async function runShell(s: Session, command: string): Promise<ShellResult> {
  const vfs = new VirtualFs(s)
  const greps = new Map(grepCommands(vfs).map((c) => [c.name, c]))
  const bash = new Bash({
    fs: vfs, cwd: '/',
    env: { HOME: '/drafts', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', USER: 'agent' },
    customCommands: [...greps.values(), ...modeWrappers()],
    executionLimitProfile: 'hardened',
    executionLimits: { maxExecutionTimeMs: LIMITS.commandMs, maxOutputSize: LIMITS.stdoutBytes * 4 },
  })
  let r: ShellResult
  try {
    if (shellMode() === 'isolated') {
      r = await runShellIsolated(command, vfs, {
        token: String(s.token.id), person: String(s.token.person_id), timeoutMs: LIMITS.commandMs,
        job: {
          cwd: '/', env: { HOME: '/drafts', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', USER: 'agent' },
          wrap: Object.keys(MODES), parentCommands: [...greps.keys()],
          bash: { executionLimitProfile: 'hardened', executionLimits: { maxOutputSize: LIMITS.stdoutBytes * 4 } },
          maxStdoutBytes: LIMITS.stdoutBytes * 4, maxStderrBytes: LIMITS.stderrBytes * 4,
        },
        hooks: {
          // read modes (raw bytes / weak provenance) are decided here, from the command line the worker reports
          withCommand: (cmd, fn) => { const m = cmd && MODES[cmd[0]!]; return m ? commandMode.run(m(cmd.slice(1)), fn) : fn() },
          runCommand: (name, args, ctx) => greps.get(name)!.execute(args, { cwd: ctx.cwd, stdin: Buffer.from(ctx.stdin).toString('latin1') } as never),
        },
      })
    } else {
      const out = await bash.exec(command, { signal: AbortSignal.timeout(LIMITS.commandMs + 2000) })
      r = { stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode }
    }
  } catch (e) {
    // just-bash lets some redirect failures escape exec(); report them like bash would
    if (!(e instanceof FsError)) throw e
    r = { stdout: '', stderr: `bash: ${e.path}: ${e.code === 'ENOENT' ? 'No such file or directory' : e.message}\n`, exitCode: 1 }
  }
  let stderr = r.stderr
  for (const note of s.notes) if (!stderr.includes(note)) stderr += `${NAME}: ${note}\n`
  if (s.extracted.size) {
    const [first] = s.extracted
    stderr = `(extracted text: ${first}${s.extracted.size > 1 ? ` and ${s.extracted.size - 1} more` : ''}; original bytes under /.raw/)\n` + stderr
  }
  return { stdout: cap(r.stdout, LIMITS.stdoutBytes, 'output'), stderr: cap(stderr, LIMITS.stderrBytes, 'stderr'), exitCode: r.exitCode }
}
