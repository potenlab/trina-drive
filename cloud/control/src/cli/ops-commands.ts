// Operator commands (workstream G1), registered through ./index.ts (asked before main.ts's own commands, so one here
// may replace a built-in: `replaces: true`). Larger commands live in their own cli/ops-*.ts files and are listed here.
//   ops-teams.ts  teams retry (+ --reset-host, review finding 24), teams set-plan (+ --complimentary), teams exec
//   ops-hosts.ts  hosts check (data volume use, isolation probes; hourly --alert from the control host's cron)
import { hostsCheck } from './ops-hosts'
import { teamsExec, teamsRetry, teamsSetPlan } from './ops-teams'
import type { ControlCommand } from './types'

export const opsCommands: ControlCommand[] = [teamsRetry, teamsSetPlan, teamsExec, hostsCheck]
