// The drive web app's frame and share dialog (workstream C1), the parts that run without a browser: the share
// adapter's view of today's folder rules API, the widening / step-up answers, the Connect page's commands, and the
// screen text (every Korean string present, same {placeholders} as the English). Browser flows: web/e2e (S10–S48).
import { describe, expect, test } from 'bun:test'
import { ApiError, type FolderDetail } from '../web/src/api'
import { AI_CLIENTS, claudeOAuthCommand, codexOAuthCommands, mcpUrl } from '../web/src/connect'
import type { FileShareView as FileView, ShareView as ApiView } from '../src/share/api-types'
import { fromApi, inMyFiles, isPersonal, linkTo, needsStepUp, recentBucket, shareChangeLines, shownPath, viewFromFolder, wideningOf } from '../web/src/drive/share-api'
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

  test('the sharing API’s answer (src/share/api-types.ts) as the dialog’s view', () => {
    const api: ApiView = {
      mode: 'managed', item: { path: '/프로젝트/비밀', kind: 'folder', name: '비밀', id: 9 }, my_role: 'editor',
      can_share: true, can_manage: false, can_grant_manager: false, can_ai_off: false, can_restrict_here: false, can_toggle_editors: false, can_invite: false, full_list: true,
      general: { effective: { role: 'viewer', from_path: '/프로젝트' }, own: null, restricted_here: false, editor_step_up: true },
      editors_can_share: { effective: true, own: null, off_above: false },
      entries: [{ subject: { type: 'person', id: 5, name: 'lee' }, role: 'manager', source: 'inherited', from_path: '/프로젝트', note: 'cannot_open', editable: false }],
      ai: { no_ai: false }, path_names_visible: true, warnings: [{ code: 'draft_copies', count: 2 }],
    }
    const v = fromApi(api)
    expect(v.folder_id).toBe(9)
    expect(v.general).toEqual({ effective: { level: 'viewer', from_path: '/프로젝트' }, own: null, restricted_here: false, editor_step_up: true })
    expect(v.editors_can_share).toEqual({ value: true, off_above: false, inherited_from: null, can_change: false })
    expect(v.entries[0]).toMatchObject({ role: 'manager', source: 'inherited', from_path: '/프로젝트', cannot_open: true, editable: false })
    expect(v.warnings).toEqual([{ code: 'draft_copies', count: 2 }])
    // set on the folder itself: not "inherited from"
    expect(fromApi({ ...api, general: { ...api.general, own: 'editor', effective: { role: 'editor', from_path: '/프로젝트/비밀' } } }).general.effective).toEqual({ level: 'editor', from_path: null })
    expect(fromApi({ mode: 'inplace', item: { path: '/nas', kind: 'folder', name: 'nas', id: 3 } })).toMatchObject({ mode: 'inplace', folder_id: 3 })
  })

  test('widening and step-up answers', () => {
    expect(wideningOf(new ApiError(409, 'widening', 'x', { count: 1, people: 3, sources: ['/경영'], sources_hidden: 1, can_confirm: false, needs_approval: true })))
      .toEqual({ count: 3, sourcesHidden: 1, sources: ['/경영'], canConfirm: false, canRequest: true })
    // a file's widening: an Editor cannot ask for approval (a manager of its folder confirms it)
    expect(wideningOf(new ApiError(409, 'widening', 'x', { code: 'widening', count: 1, people: 2, sources: [], sources_hidden: 0, can_confirm: false, needs_approval: true }), 'file'))
      .toMatchObject({ canConfirm: false, canRequest: false, count: 2 })
    expect(wideningOf(new ApiError(409, 'widening', 'x', { count: 2 }))?.canConfirm).toBe(true)
    expect(wideningOf(new ApiError(409, 'exists', 'x'))).toBeNull()
    expect(wideningOf(new Error('x'))).toBeNull()
    expect(needsStepUp(new ApiError(403, 'step_up_required', 'x'))).toBe(true)
    expect(needsStepUp(new ApiError(403, 'not_manager', 'x'))).toBe(false)
    expect(linkTo('https://trina.cloud.trina.app', '/재무 2026')).toBe('https://trina.cloud.trina.app/#/files?p=%2F%EC%9E%AC%EB%AC%B4%202026')
    expect(linkTo('https://x.test', '/a b/c.md', 'file')).toBe('https://x.test/#/files?p=%2Fa%20b&s=%2Fa%20b%2Fc.md')
    expect(isPersonal(new ApiError(409, 'personal', 'x'))).toBe(true)
    expect(isPersonal(new ApiError(403, 'not_manager', 'x'))).toBe(false)
  })

  test('a file’s answer (A2) as the dialog’s view', () => {
    const file: FileView = {
      mode: 'managed', item: { path: '/경영/결산/Q3.xlsx', kind: 'file', name: 'Q3.xlsx' }, my_role: 'editor', can_manage: true, manage_as: 'editor',
      can_grant_manager: false, can_invite: false, can_confirm_widening: false, can_ai_off: false,
      editors_can_share: { effective: true, from_path: null },
      general: { effective: { role: 'viewer', from_path: '/경영' }, own: null, can_restrict: false, editor_step_up: true },
      entries: [
        { subject: { type: 'person', id: 12, name: 'mina', email: null }, role: 'viewer', source: 'direct', granted_by: { id: 3, name: 'dion' }, granted_at: 1, editable: true, inherited_role: 'viewer' },
        { subject: { type: 'group', id: 4, name: 'finance', members: 5 }, role: 'editor', source: 'inherited', from_path: '/경영/결산', editable: false },
      ],
      inherited: 'shown', ai: { no_ai: true, inherited_no_ai_from: '/경영' }, path_names_visible: '/경영/결산', warnings: [{ code: 'draft_copy' }],
    }
    const v = fromApi(file)
    expect(v.item.kind).toBe('file')
    // an Editor shares the file (can_share) but is not a manager (no folder-only powers)
    expect([v.can_manage, v.can_share, v.can_grant_manager]).toEqual([false, true, false])
    expect(v.general).toEqual({ effective: { level: 'viewer', from_path: '/경영' }, own: null, restricted_here: false, editor_step_up: true, can_restrict: false })
    expect(v.entries.map((e) => [e.subject.name, e.role, e.source, e.inherited_role ?? null])).toEqual([['mina', 'viewer', 'direct', 'viewer'], ['finance', 'editor', 'inherited', null]])
    expect(v.path_names_visible).toBe('/경영/결산')
    expect(v.ai).toEqual({ no_ai: true, inherited_no_ai_from: '/경영' })
    expect(v.warnings).toEqual([{ code: 'draft_copy' }])
    expect(v.editors_can_share).toBeUndefined()
    // turned off above: said, so a read-only dialog can explain itself
    expect(fromApi({ ...file, can_manage: false, editors_can_share: { effective: false, from_path: '/경영' } }).editors_can_share).toEqual({ value: false, off_above: true, inherited_from: '/경영', can_change: false })
    // a manager of the folder, or an admin: can_manage
    expect(fromApi({ ...file, manage_as: 'manager' }).can_manage).toBe(true)
    // the file itself carries General access: not "from the folder"
    expect(fromApi({ ...file, general: { ...file.general!, own: 'editor', effective: { role: 'editor', from_path: file.item.path } } }).general.effective).toEqual({ level: 'editor', from_path: null })
    // My files / NAS: nothing to change
    expect(fromApi({ mode: 'personal', item: file.item, my_role: 'editor', can_manage: false, entries: [], general: null })).toMatchObject({ mode: 'personal', can_manage: false, can_share: false, entries: [] })
    expect(fromApi({ mode: 'inplace', item: file.item, entries: [] }).mode).toBe('inplace')
    // a non-sharer: entries [] and general null
    expect(fromApi({ mode: 'managed', item: file.item, my_role: 'viewer', can_manage: false, entries: [], general: null })).toMatchObject({ can_manage: false, can_share: false, general: { effective: null } })
  })

  test('My files paths', () => {
    expect(inMyFiles('/mina (personal)', '/mina (personal)')).toBe(true)
    expect(inMyFiles('/mina (personal)/a/b.md', '/mina (personal)')).toBe(true)
    expect(inMyFiles('/mina (personal) 2', '/mina (personal)')).toBe(false)
    expect(inMyFiles('/공용', null)).toBe(false)
    expect(inMyFiles('/공용', undefined)).toBe(false)
    expect(shownPath('/mina (personal)/a', '/mina (personal)', 'My files')).toBe('My files/a')
    expect(shownPath('/공용/a', '/mina (personal)', 'My files')).toBe('/공용/a')
  })
})

describe('Recent and the approval inbox', () => {
  test('Recent groups by the viewer’s day', () => {
    const now = new Date(2026, 9, 23, 15, 0).getTime() // a Friday afternoon, local time
    const at = (d: number, h = 9) => new Date(2026, 9, d, h, 0).getTime()
    expect(recentBucket(at(23, 0), now)).toBe('rc_today')
    expect(recentBucket(at(22, 23), now)).toBe('rc_yesterday')
    expect(recentBucket(at(22, 0), now)).toBe('rc_yesterday')
    expect(recentBucket(at(17), now)).toBe('rc_week')
    expect(recentBucket(at(16, 23), now)).toBe('rc_older')
  })

  test('a share request in counts and roles, never names', () => {
    expect(shareChangeLines({
      path: '/프로젝트', notify: true, confirm_widening: true,
      add: [{ subject: { type: 'person', id: 2 }, role: 'editor' }, { subject: { type: 'group', id: 6 }, role: 'editor' }, { subject: { type: 'person', id: 3 }, role: 'viewer' }, { subject: { email: 'x@y.test' }, role: 'viewer' }],
      set: [{ subject: { type: 'person', id: 4 }, role: 'viewer' }, { subject: { type: 'person', id: 5 }, role: 'remove' }],
      general: { mode: 'team', role: 'editor' }, restrict_here: { on: true },
    })).toEqual([
      { key: 'ap_share_add', n: 2, role: 'editor' }, { key: 'ap_share_add', n: 1, role: 'viewer' }, { key: 'ap_share_invite', n: 1, role: 'viewer' },
      { key: 'ap_share_set', n: 1 }, { key: 'ap_share_remove', n: 1 }, { key: 'ap_share_general_team', role: 'editor' }, { key: 'ap_share_restrict' },
    ])
    expect(shareChangeLines({ general: { mode: 'restricted' }, editors_can_share: false })).toEqual([{ key: 'ap_share_general_restricted' }, { key: 'ap_share_other' }])
    expect(shareChangeLines(undefined)).toEqual([])
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
