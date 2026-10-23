// S15 (plan 5, O1 version of 10.1/10.2-8): who may do what in the share dialog.
//  A. On today's server (folder rules API): lee, a Manager who is not an admin, shares /프로젝트 with mina as Editor,
//     is not offered Manager (and the server refuses it), may turn "No AI" on but not off; kim (Editor, no sharing
//     on this server) gets the dialog read-only.
//  B. With the sharing API (mocked to the plan 3.7 contract until A1 lands — web/e2e/mock-share.mjs): kim as Editor
//     while "Editors can change permissions and share" is on: adds people (no Manager), a widening answer leads to
//     "Request approval", opening to the whole team asks for the step-up code; lee as Manager confirms a widening and
//     turns the toggle off, after which kim's dialog is read-only. The dialog works from the keyboard.
import { check, shot, signedIn } from './lib.mjs'
import { shareMock } from './mock-share.mjs'

const P = '/프로젝트'
async function openShare(page, fx) {
  await page.goto(fx.base + '/#/files?p=' + encodeURIComponent(P))
  await page.locator('.fv-share').click()
  await page.waitForSelector('.sd-body, .sd-pad')
  await page.waitForTimeout(150)
}

export async function s15(browser, fx) {
  console.log('S15 share roles: Manager (not admin), Editor; O1 toggle, widening, step-up, keyboard')
  // ---- A: today's server ----
  const lee = await signedIn(browser, fx, 'lee')
  await openShare(lee, fx)
  await lee.fill('.sd-combo input', 'mina')
  await lee.locator('.sd-options li', { hasText: 'mina' }).click()
  const roles = await lee.locator('.sd-add-row .sd-role option').allTextContents()
  check(!roles.includes('Manager'), 'A: a Manager who is not an admin is not offered Manager')
  await lee.selectOption('.sd-add-row .sd-role', 'editor')
  await lee.locator('.sd-add-foot button', { hasText: 'Share' }).click()
  await lee.locator('.sd-note', { hasText: 'Access updated.' }).waitFor()
  check(await lee.locator('.sd-entry', { hasText: 'mina' }).locator('.sd-role').inputValue() === 'editor', 'A: lee shared /프로젝트 with mina as Editor')
  check(await lee.locator('.sd-entry', { hasText: 'lee' }).locator('select').count() === 0, 'A: lee cannot change Manager rows')
  const folders = await (await lee.request.get(fx.base + '/api/folders')).json()
  const proj = folders.folders.find((f) => f.vpath === P)
  const mina = (await (await lee.request.get(fx.base + '/api/people')).json()).people.find((p) => p.name === 'mina')
  const grant = await lee.request.put(`${fx.base}/api/folders/${proj.id}/managers/${mina.id}`, { headers: { origin: fx.base, 'x-csrf-token': await csrf(lee, fx) } })
  check(grant.status() === 403, 'A: the server refuses Manager from a non-admin (403)')
  // No AI: on is allowed, off is admin-only
  await lee.locator('.sd-toggle', { hasText: 'AI read this' }).locator('input').click()
  await lee.locator('.sd-note', { hasText: 'Access updated.' }).waitFor()
  const ai = lee.locator('.sd-toggle', { hasText: 'AI read this' })
  check(!(await ai.locator('input').isChecked()) && await ai.locator('input').isDisabled(), 'A: lee turned "No AI" on and cannot turn it off')
  check((await ai.textContent()).includes('Only an admin can turn it off'), 'A: the dialog says only an admin turns it off')
  await shot(lee, 's15-manager-legacy')
  await lee.context().close()

  const kim = await signedIn(browser, fx, 'kim')
  await openShare(kim, fx)
  check(await kim.locator('.sd-ro', { hasText: 'Only managers can change access' }).count() === 1 && await kim.locator('.sd-combo').count() === 0, 'A: kim (Editor) sees the dialog read-only on this server')
  check(await kim.locator('.sd-entry').count() >= 2, 'A: …and still sees who has access')
  await kim.context().close()

  // ---- B: the sharing API (O1) ----
  const m = shareMock({ path: P, as: 'editor' })
  const ed = await signedIn(browser, fx, 'kim')
  await m.install(ed)
  await openShare(ed, fx)
  check(await ed.locator('.sd-combo').count() === 1, 'B: an Editor may share while the toggle is on')
  await ed.fill('.sd-combo input', 'mina')
  await ed.locator('.sd-options li', { hasText: 'mina' }).click()
  check(!(await ed.locator('.sd-add-row .sd-role option').allTextContents()).includes('Manager'), 'B: an Editor is not offered Manager')
  check(await ed.locator('.sd-toggle', { hasText: 'Editors can change' }).locator('input').isDisabled(), 'B: an Editor cannot change the toggle')
  check(await ed.locator('button', { hasText: 'Restrict access here' }).count() === 0, 'B: an Editor is not offered Restrict access here')
  await ed.locator('.sd-add-foot button', { hasText: 'Share' }).click()
  await ed.locator('.sd-alert', { hasText: 'More people would read AI-draft copies' }).waitFor()
  check(await ed.locator('.sd-alert button', { hasText: 'Share anyway' }).count() === 0, 'B: widening → an Editor cannot confirm it')
  await ed.locator('.sd-alert button', { hasText: 'Request approval' }).click()
  await ed.locator('.sd-note', { hasText: 'Approval requested' }).waitFor()
  check(m.state.posts.at(-1)?.request_approval === true, 'B: Request approval sends request_approval')
  await ed.selectOption('.sd-general select.sd-plain', 'team')
  await ed.locator('.sd-alert', { hasText: 'Confirm it’s you' }).waitFor()
  await shot(ed, 's15-editor-stepup')
  await ed.fill('.sd-alert input', '123456')
  await ed.locator('.sd-alert button', { hasText: 'Confirm' }).click()
  await ed.locator('.sd-alert').waitFor({ state: 'detached' })
  check(await ed.locator('.sd-general select.sd-plain').inputValue() === 'team', 'B: General access now says Anyone in Trina')
  check(m.state.general === 'viewer' && m.state.posts.at(-1)?.step_up?.code === '123456', 'B: opening to the team went through with the step-up code')
  await ed.context().close()

  const mg = shareMock({ path: P, as: 'manager' })
  const man = await signedIn(browser, fx, 'lee')
  await mg.install(man)
  await openShare(man, fx)
  await man.fill('.sd-combo input', 'mina')
  await man.locator('.sd-options li', { hasText: 'mina' }).click()
  await man.locator('.sd-add-foot button', { hasText: 'Share' }).click()
  await man.locator('.sd-alert button', { hasText: 'Share anyway' }).click()
  await man.locator('.sd-entry', { hasText: 'mina' }).waitFor()
  check(mg.state.posts.at(-1)?.confirm_widening === true, 'B: a Manager confirms a widening (confirm_widening)')
  const tog = man.locator('.sd-toggle', { hasText: 'Editors can change' }).locator('input')
  check(await tog.isEnabled() && await tog.isChecked(), 'B: a Manager sees "Editors can change permissions and share" on')
  await tog.click()
  await man.locator('.sd-note', { hasText: 'Access updated.' }).waitFor()
  check(mg.state.editors_can_share === false, 'B: the Manager turned it off')
  await shot(man, 's15-manager-o1')
  await man.context().close()

  const ro = shareMock({ path: P, as: 'editor', editorsCanShare: false })
  const ed2 = await signedIn(browser, fx, 'kim')
  await ro.install(ed2)
  // keyboard: Tab to Share, Enter opens, focus lands in the dialog, Escape closes and gives focus back
  await ed2.goto(fx.base + '/#/files?p=' + encodeURIComponent(P))
  await ed2.locator('.fv-share').focus()
  await ed2.keyboard.press('Enter')
  await ed2.waitForSelector('.sd-body')
  check(await ed2.evaluate(() => !!document.activeElement?.closest('.sd')), 'B: keyboard: focus moves into the dialog')
  for (let i = 0; i < 12; i++) await ed2.keyboard.press('Tab')
  check(await ed2.evaluate(() => !!document.activeElement?.closest('.sd')), 'B: keyboard: Tab stays inside the dialog')
  check(await ed2.locator('.sd-combo').count() === 0 && await ed2.locator('.sd-ro').count() === 1, 'B: toggle off → the Editor’s dialog is read-only')
  await ed2.keyboard.press('Escape')
  check(await ed2.locator('.sd').count() === 0 && await ed2.evaluate(() => document.activeElement?.classList.contains('fv-share')), 'B: keyboard: Escape closes and focus returns to Share')
  check(ed2.errors.length === 0, 'no page errors' + (ed2.errors.length ? ': ' + ed2.errors.join(' | ') : ''))
  await ed2.context().close()
}

async function csrf(page, fx) {
  return (await (await page.request.get(fx.base + '/api/session')).json()).csrf
}
