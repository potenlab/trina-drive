// Every scenario, in run order (plan §10.5). Phase 1 = the release gate; each file runs alone (run.ts --only Sxx).
import type { Scenario } from '../lib/ctx'
import m01 from './m01-matrix'
import s10 from './s10-files'
import s12 from './s12-finance-hidden'
import s14 from './s14-restrict-here'
import s15 from './s15-manager-o1'
import s17 from './s17-revoke'
import s18 from './s18-no-ai'
import s19 from './s19-managed-rejudge'
import s24 from './s24-agent-writes'
import s25 from './s25-scoped-token'
import s43 from './s43-agents-never-share'
import s47 from './s47-noai-webdav'

export const SCENARIOS: Scenario[] = [s10, s12, m01, s14, s15, s17, s18, s19, s24, s25, s43, s47]
