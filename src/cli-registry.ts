// Product CLI commands that feature modules contribute (W0 seams), checked by src/cli.ts after its built-in commands.
// A module adds a command to its own list, never cli.ts:
//   src/tdcloud/cli.ts  cloudCommands  `cloud sync-members`, `cloud usage`, `people reset-link` (workstream B1)
// A built-in command with the same words wins (a module cannot replace one by accident; test/cli-registry.test.ts).
import type { DB } from './db'
import { cloudCommands } from './tdcloud/cli'

export interface CliContext {
  db: DB
  dataDir: string
  /** the arguments after the command's words (`cloud sync-members --json X` → ['--json', 'X']) */
  args: string[]
  out: (s: string) => void
  err: (s: string) => void
}

export interface CliCommand {
  /** one or two words: 'cloud sync-members', 'people reset-link' */
  name: string
  /** lines for `help`, already indented like src/cli.ts's HELP */
  help: string
  /** the exit code (0 when it returns nothing) */
  run: (c: CliContext) => Promise<number | void> | number | void
}

export const CLI_COMMANDS: CliCommand[] = [...cloudCommands]

/** The registered command these arguments name (two words first, then one), with the arguments after its words. */
export function findCommand(args: string[], list: CliCommand[] = CLI_COMMANDS): { command: CliCommand; rest: string[] } | null {
  const two = args.slice(0, 2).join(' '), one = args[0] ?? ''
  const c = list.find((x) => x.name === two) ?? list.find((x) => x.name === one)
  return c ? { command: c, rest: args.slice(c.name.split(' ').length) } : null
}

/** Help lines of the registered commands ('' when there are none). */
export function registeredHelp(list: CliCommand[] = CLI_COMMANDS): string {
  return list.length ? `\n\nTrina Cloud and other modules:\n${list.map((c) => c.help).join('\n')}` : ''
}
