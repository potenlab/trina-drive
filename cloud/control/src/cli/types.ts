// An admin CLI command a feature module contributes to the control plane (W0 seams); main.ts asks the registry
// (index.ts) before its own commands, so a module may also take over one (e.g. `teams retry`, with replaces: true).
import type { Cloud } from '../cloud'
import type { Config } from '../config'
import type { TeamRow } from '../db'

export interface ControlCliCtx {
  cloud: Cloud
  cfg: Config
  /** audit actor: admin:$SUDO_USER or admin:$USER */
  actor: string
  /** the arguments after the command's words */
  rest: string[]
  /** the team named by rest[0], or a usage error */
  team: () => TeamRow
  /** take `--name value` out of rest (usage error when the value is missing) */
  take: (name: string) => string | undefined
}

export interface ControlCommand {
  /** one or two words: 'teams restore', 'members list' */
  name: string
  /** lines for `help`, indented like main.ts's HELP */
  help: string
  /** the exit code */
  run: (c: ControlCliCtx) => Promise<number> | number
  /** true = this takes over a built-in command of main.ts with the same name on purpose (else a test fails) */
  replaces?: boolean
}
