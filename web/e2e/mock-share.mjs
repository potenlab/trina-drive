// A stand-in for the sharing API (src/share/api-types.ts, workstream A1) in the browser, through Playwright's request
// routing: GET/POST /api/share, /api/share/step-up(/options), /api/directory, /api/shared-with-me. It lets a script
// set up the O1 states it needs (an Editor while "Editors can share" is on or off, a widening, the step-up) at once.
// It keeps one folder's state in memory and answers the way the contract says, so the share dialog's O1 flows
// (Editors can share, the widening 409, the Editor's step-up) can be driven before the real API is merged.
// Once A1 lands, the same scripts run against the real server without this file (see s15.mjs).

export function shareMock({ path = '/프로젝트', as = 'editor', editorsCanShare = true, widensOn = ['mina'] } = {}) {
  const people = [{ id: 1, name: 'boss', email: 'boss@trina.test' }, { id: 2, name: 'mina', email: 'mina@trina.test' }, { id: 3, name: 'sam', email: 'sam@trina.test' }, { id: 4, name: 'kim', email: 'kim@trina.test' }, { id: 5, name: 'lee', email: 'lee@trina.test' }]
  const groups = [{ id: 1, name: '전체', size: 5, everyone: true }, { id: 2, name: '재무', size: 1 }, { id: 3, name: '경영', size: 1 }]
  const st = {
    editors_can_share: editorsCanShare,
    general: null, // null | 'viewer' | 'editor'
    no_ai: false,
    entries: [
      { subject: { type: 'person', id: 5, name: 'lee', email: 'lee@trina.test' }, role: 'manager', source: 'direct' },
      { subject: { type: 'person', id: 4, name: 'kim', email: 'kim@trina.test' }, role: 'editor', source: 'direct' },
      { subject: { type: 'group', id: 3, name: '경영', members: 1 }, role: 'viewer', source: 'inherited', from_path: '/경영' },
    ],
    posts: [],
  }
  const manager = as === 'manager'
  const canShare = () => manager || st.editors_can_share
  const view = () => ({
    mode: 'managed', item: { path, kind: 'folder', name: path.slice(path.lastIndexOf('/') + 1), id: 4 },
    my_role: as, can_share: canShare(), can_manage: manager, can_grant_manager: false, can_ai_off: false, can_restrict_here: manager,
    can_toggle_editors: manager, can_invite: false, full_list: true,
    general: { effective: st.general ? { role: st.general, from_path: path } : null, own: st.general, restricted_here: false, editor_step_up: !manager },
    editors_can_share: { effective: st.editors_can_share, own: st.editors_can_share, off_above: false },
    entries: st.entries.map((e) => ({ ...e, editable: e.source === 'direct' && canShare() && (manager || e.role !== 'manager') })),
    ai: { no_ai: st.no_ai }, path_names_visible: true, warnings: [],
  })
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  const name = (s) => people.find((p) => s.type === 'person' && p.id === s.id)?.name ?? groups.find((g) => s.type === 'group' && g.id === s.id)?.name ?? '?'

  async function install(page) {
    await page.route('**/api/directory', (r) => json(r, 200, { people, groups }))
    await page.route('**/api/shared-with-me', (r) => json(r, 200, { items: [{ path, kind: 'folder', name: view().item.name, role: as, shared_by: { id: 1, name: 'boss' }, shared_at: Date.parse('2026-10-22T09:00:00Z') }] }))
    await page.route('**/api/share/step-up/options', (r) => json(r, 200, { method: 'totp' }))
    await page.route('**/api/share/step-up', (r) => r.request().postDataJSON().code === '123456' ? json(r, 200, { assertion: 'stepup-ok', expires_at: Date.now() + 60_000 }) : json(r, 400, { error: 'bad_code', message: 'that code is not right' }))
    await page.route(/\/api\/share(\?|$)/, async (r) => {
      const req = r.request()
      if (req.method() === 'GET') return json(r, 200, view())
      const b = req.postDataJSON()
      st.posts.push(b)
      const editing = !manager
      if (editing && !st.editors_can_share) return json(r, 403, { error: 'not_manager', message: 'only managers can change access here' })
      const adds = [...(b.add ?? []), ...(b.set ?? [])]
      if (editing && (adds.some((a) => a.role === 'manager') || b.restrict_here || b.editors_can_share !== undefined)) return json(r, 403, { error: 'not_manager', message: 'only managers can do that' })
      if (editing && b.general?.mode === 'team' && b.step_up !== 'stepup-ok') return json(r, 403, { error: 'step_up_required', message: 'confirm with your passkey' })
      const widens = (b.add ?? []).some((a) => widensOn.includes(name(a.subject)))
      if (widens && !b.confirm_widening) return json(r, 409, { error: 'widening', code: 'widening', message: 'widens', count: 1, people: 2, sources: [], sources_hidden: 1, can_confirm: manager, needs_approval: !manager })
      if (widens && editing) return json(r, 202, { status: 'approval_pending', approval_id: 7, widens: 2 })
      for (const a of b.add ?? []) st.entries.push({ subject: { ...a.subject, name: name(a.subject) }, role: a.role, source: 'direct' })
      for (const s of b.set ?? []) {
        const i = st.entries.findIndex((e) => e.subject.type === s.subject.type && e.subject.id === s.subject.id && e.source === 'direct')
        if (i >= 0) { if (s.role === 'remove') st.entries.splice(i, 1); else st.entries[i] = { ...st.entries[i], role: s.role } }
      }
      if (b.general) st.general = b.general.mode === 'team' ? b.general.role ?? 'viewer' : null
      if (typeof b.editors_can_share === 'boolean') st.editors_can_share = b.editors_can_share
      if (typeof b.ai_access === 'boolean') st.no_ai = !b.ai_access
      return json(r, 200, { ...view(), widens: widens ? 2 : 0, invited: [] })
    })
  }
  return { install, state: st }
}
