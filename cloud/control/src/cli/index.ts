// The control plane's CLI registry (W0 seams), imported once by main.ts. A module adds commands to its own list:
//   ./ops-commands.ts      opsCommands      operations (workstream G1)
//   ./console-commands.ts  consoleCommands  the console (workstream D1)
// A new module list is added here by the integrator (one line). cloud/control/test/registry.test.ts checks that no
// two registered commands share a name.
import { consoleCommands } from './console-commands'
import { opsCommands } from './ops-commands'
import type { ControlCommand } from './types'

export const CONTROL_COMMANDS: ControlCommand[] = [...opsCommands, ...consoleCommands]

export function findCommand(cmd: string, sub: string | undefined, list: ControlCommand[] = CONTROL_COMMANDS): ControlCommand | null {
  const two = `${cmd} ${sub ?? ''}`.trim()
  return list.find((c) => c.name === two) ?? list.find((c) => c.name === cmd) ?? null
}

/** Help lines of the registered commands ('' when there are none). */
export function registeredHelp(list: ControlCommand[] = CONTROL_COMMANDS): string {
  return list.length ? `\n\n${list.map((c) => c.help).join('\n')}` : ''
}
