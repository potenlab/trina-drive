// Console-side admin commands (workstream D1): e.g. `members list <slug>`, `members sync <slug>`, `sso keys`.
// Registered through ./index.ts.
import type { ControlCommand } from './types'

export const consoleCommands: ControlCommand[] = []
