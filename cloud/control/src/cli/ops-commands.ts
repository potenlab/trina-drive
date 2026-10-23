// Operator commands (workstream G1): `teams restore`, `teams exec`, `hosts check`, `teams retry` with the host
// reference reset, … Registered through ./index.ts (asked before main.ts's own commands, so one here may replace a
// built-in). Put larger commands in their own cli/ops-*.ts files and list them here.
import type { ControlCommand } from './types'

export const opsCommands: ControlCommand[] = []
