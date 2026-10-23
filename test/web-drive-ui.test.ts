// The drive web app's frame and share dialog (workstream C1), the parts that run without a browser: the share
// adapter's view of today's folder rules API, the widening / step-up answers, the Connect page's commands, and the
// screen text (every Korean string present, same {placeholders} as the English). Browser flows: web/e2e (S10–S48).
import { describe, expect, test } from 'bun:test'
import { ApiError, type FolderDetail } from '../web/src/api'
import { AI_CLIENTS, claudeOAuthCommand, codexOAuthCommands, mcpUrl } from '../web/src/connect'
import { linkTo, needsStepUp, viewFromFolder, wideningOf } from '../web/src/drive/share-api'
import * as consoleText from '../web/src/i18n/console'
import * as core from '../web/src/i18n/core'
import * as share from '../web/src/i18n/share'
import * as sso from '../web/src/i18n/sso'

const summary = (over: Partial<FolderDetail['folder']> = {}): FolderDetail['folder'] => ({
  managed: true, id: 7, name: '프로젝트', vpath: '/프로젝트', registered: true, personal_owner: null, no_ai: false, quarantine: false, widened_pending: false,
  inherit_break: true, blocked: false, nas_mode: null, status: 'ok', mine: { ai: true, nas: null, manage: true },
  can: { edit_rules: true, no_ai_on: true, no_ai_off: false, edit_nas: false, admin: false }, ...over,
})
const row = (type: 'group' | 'person', id: number, name: string, level: number, via: 'direct' | 'inherited' | 'group' | null, from: string | null = null, members?: number) =>
  ({ type, id, name, members, ai: { direct: via === 'direct', level, via, inherited_from: from }, nas: null, warn: false })

describe('share adapter on the folder rules API', () => {
  const detail: FolderDetail = {
    folder: summary(),
    managers: [{ id: 5, name: 'lee', direct: true }],
    subfolders: [], parent: null, nas_history: [],
    rows: [
      row('group', 1, '전체', 1, 'direct', null, 5), row('group', 2, '재무', 0, null), row('group', 3, '경영', 1, 'inherited', '/', 1),
      row('person', 4, 'kim', 2, 'direct'), row('person', 5, 'lee', 2, 'direct'), row('person', 2, 'mina', 1, 'group'), row('person', 3, 'sam', 1, 'inherited', '/'),
    ],
  }

  test('roles, sources and General access', () => {
    const v = viewFromFolder('/프로젝트', detail, { id: 5 })
    expect(v.general).toEqual({ effective: { level: 'viewer', from_path: null }, own: 'viewer', restricted_here: false })
    expect(v.entries.map((e) => [e.subject.name, e.role, e.source, e.from_path ?? null])).toEqual([
      ['경영', 'viewer', 'inherited', '/'], ['kim', 'editor', 'direct', null], ['lee', 'manager', 'direct', null], ['sam', 'viewer', 'inherited', '/'],
    ])
    // mina reaches it only through a group: the group's row says it, not hers; 재무 has no access
    expect(v.entries.some((e) => e.subject.name === 'mina' || e.subject.name === '재무')).toBe(false)
    expect(v.my_role).toBe('manager')
    expect(v.can_manage).toBe(true)
    expect(v.can_grant_manager).toBe(false) // not an admin
    expect(v.can_ai_off).toBe(false)
    expect(v.can_restrict_here).toBe(false) // a top folder always starts fresh
    expect(v.editors_can_share).toBeUndefined() // only the sharing API knows the O1 toggle
  })

  test('an Editor, a subfolder that starts fresh, a manage-only grant, an admin', () => {
    const sub: FolderDetail = { ...detail, folder: summary({ id: 8, name: '비밀', vpath: '/프로젝트/비밀', registered: false, mine: { ai: true, nas: null, manage: false }, can: { ...summary().can, edit_rules: false } }), managers: [{ id: 9, name: 'old', direct: true }] }
    const v = viewFromFolder('/프로젝트/비밀', sub, { id: 4 })
    expect(v.my_role).toBe('editor')
    expect(v.can_manage).toBe(false)
    expect(v.general.restricted_here).toBe(true)
    expect(v.entries.find((e) => e.subject.name === 'old')).toMatchObject({ role: 'manager', source: 'direct' })
    const admin = viewFromFolder('/프로젝트', { ...detail, folder: summary({ can: { ...summary().can, admin: true, no_ai_off: true } }) }, { id: 1 })
    expect(admin.can_grant_manager).toBe(true)
    expect(admin.can_ai_off).toBe(true)
    // seen from the nearest folder above (no row of its own): read-only
    expect(viewFromFolder('/프로젝트/x', detail, { id: 5 }, false).can_manage).toBe(false)
  })

  test('widening and step-up answers', () => {
    expect(wideningOf(new ApiError(409, 'widening', 'x', { count: 3, sources_hidden: 1, can_confirm: false }))).toEqual({ count: 3, sourcesHidden: 1, canConfirm: false })
    expect(wideningOf(new ApiError(409, 'widening', 'x', { count: 2 }))?.canConfirm).toBe(true)
    expect(wideningOf(new ApiError(409, 'exists', 'x'))).toBeNull()
    expect(wideningOf(new Error('x'))).toBeNull()
    expect(needsStepUp(new ApiError(403, 'step_up_required', 'x'))).toBe(true)
    expect(needsStepUp(new ApiError(403, 'not_manager', 'x'))).toBe(false)
    expect(linkTo('https://trina.cloud.trina.app', '/재무 2026')).toBe('https://trina.cloud.trina.app/#/files?p=%2F%EC%9E%AC%EB%AC%B4%202026')
  })
})

describe('Connect your AI', () => {
  test('remote MCP commands for the clients that sign in through the browser', () => {
    const c = { entry: 'trina-drive', origin: 'https://trina.cloud.trina.app/' }
    expect(mcpUrl(c.origin)).toBe('https://trina.cloud.trina.app/mcp')
    expect(claudeOAuthCommand(c)).toBe('claude mcp add --transport http --scope user trina-drive https://trina.cloud.trina.app/mcp')
    expect(codexOAuthCommands(c)).toEqual(['codex mcp add trina-drive --url https://trina.cloud.trina.app/mcp', 'codex mcp login trina-drive'])
    expect(claudeOAuthCommand({ entry: 'trina-drive', origin: "https://x.test/a b'" })).toContain(`'https://x.test/a b'\\''/mcp'`)
    expect([...AI_CLIENTS]).toEqual(['claude', 'codex', 'claude_ai', 'chatgpt', 'cursor'])
  })
})

describe('screen text', () => {
  const files = { core, share, sso, console: consoleText } as Record<string, { en: Record<string, string>; ko: Record<string, string> }>
  const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  test('every Korean string is there, not empty, with the English one’s placeholders', () => {
    const bad: string[] = []
    for (const [f, d] of Object.entries(files)) {
      for (const [k, en] of Object.entries(d.en)) {
        const ko = d.ko[k]
        if (!ko?.trim()) bad.push(`${f}.${k}: empty`)
        else if (JSON.stringify(holes(ko)) !== JSON.stringify(holes(en))) bad.push(`${f}.${k}: {${holes(en)}} vs {${holes(ko)}}`)
      }
    }
    expect(bad).toEqual([])
  })
  test('the share dialog and the frame are translated (Korean differs from English)', () => {
    const same = Object.keys(share.en).filter((k) => (share.en as Record<string, string>)[k] === (share.ko as Record<string, string>)[k])
    expect(same).toEqual([])
    for (const k of ['nav_team_folders', 'nav_connect', 'nav_mount', 'mount_no_ai_note', 'cai_intro'] as const) expect(core.ko[k]).not.toBe(core.en[k])
  })
})
