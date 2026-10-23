// M01 — the permissions matrix: every seeded file × every person × every way in (web list/download/search, WebDAV,
// MCP), including the No AI folders (people see them, their AI does not) and Restrict here (/프로젝트/비밀). Every
// "no" must be indistinguishable from a path that does not exist.
import { FILES } from '../../seed-team'
import type { Scenario } from '../lib/ctx'
import type { Who } from '../lib/fixture'
import { expectSight } from '../lib/see'

/** who may open each seeded file (people), and whose AI may read it (No AI on 경영, 인사) */
export const EXPECT: Record<string, { human: Who[]; ai: Who[] }> = {
  '/공용/notice.md': { human: ['admin', 'boss', 'mina', 'sam', 'kim'], ai: ['admin', 'boss', 'mina', 'sam', 'kim'] },
  '/경영/board.md': { human: ['boss'], ai: [] },
  '/재무/결산.md': { human: ['sam', 'kim'], ai: ['sam', 'kim'] },
  '/프로젝트/plan.md': { human: ['admin', 'boss', 'mina', 'sam', 'kim'], ai: ['admin', 'boss', 'mina', 'sam', 'kim'] },
  '/프로젝트/비밀/secret.md': { human: ['boss', 'sam', 'kim'], ai: ['boss', 'sam', 'kim'] },
  '/인사/hr.md': { human: ['boss'], ai: [] },
}

export default {
  id: 'M01', title: 'permissions matrix: 5 people × 6 folders × web/search/WebDAV/MCP, hidden == nonexistent', phase: 1, targets: ['local', 'aws'], uses: 'H1 MCP DAV',
  async run(t) {
    for (const [file, canary] of Object.entries(FILES)) {
      t.step(file)
      for (const who of ['admin', 'boss', 'mina', 'sam', 'kim'] as Who[]) {
        const e = EXPECT[file]!
        await expectSight(t, who, file, canary, { human: e.human.includes(who), ai: e.ai.includes(who) })
      }
    }
  },
} satisfies Scenario
