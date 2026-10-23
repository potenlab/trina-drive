// S16 (Trina Cloud, fixture --cloud): an admin shares a file with an address that is not in the team yet. The picker
// offers "Invite <address>"; sharing sends the invitation through the team's invite flow (a stand-in for the console
// here) and the dialog lists the address under "Invited, waiting to join". A non-admin is never offered an invitation.
// When the address joins (the member sync, here the fixture's /join hook) the pending share is applied: the new member
// finds the file in Shared with me and its folder shows that file alone.
import { check, shot, signedIn } from './lib.mjs'

const enc = encodeURIComponent
const EMAIL = 'newbie@trina.test'

export async function s16(browser, fx) {
  console.log('S16 invite by mail: admin → pending invite → joins → the share is applied')
  const boss = await signedIn(browser, fx, 'boss')
  await boss.goto(fx.base + '/#/files?p=' + enc('/경영'))
  const row = boss.locator('.fv-items > li', { hasText: '이사회.md' })
  await row.click({ button: 'right' })
  await boss.locator('.fv-menu button', { hasText: 'Share' }).click()
  await boss.waitForSelector('.sd-body')
  await boss.fill('.sd-combo input', EMAIL)
  const opt = boss.locator('.sd-options li.invite')
  await opt.waitFor()
  check((await opt.textContent()).includes('Invite ' + EMAIL), 'the admin is offered "Invite newbie@trina.test"')
  await opt.click()
  check(await boss.locator('.sd-chip.invite', { hasText: EMAIL }).count() === 1, 'the address is picked as an invitation')
  check(await boss.locator('.sd-add', { hasText: 'People outside the team get an invitation' }).count() === 1, 'the dialog says what happens to people outside the team')
  await boss.locator('.sd-add-foot button', { hasText: 'Share' }).click()
  await boss.locator('.sd-note', { hasText: 'Invited 1 by mail.' }).waitFor()
  const pend = boss.locator('.sd-invited .sd-entry', { hasText: EMAIL })
  check(await pend.count() === 1 && (await pend.textContent()).includes('Viewer after joining'), 'pending: "Invited, waiting to join" · Viewer after joining')
  const inv = await (await fetch(fx.hooks + '/invited')).json()
  check(inv.invited.includes(EMAIL), 'the invitation went through the team’s invite flow')
  for (const theme of ['light', 'dark']) {
    await boss.emulateMedia({ colorScheme: theme })
    await shot(boss, `s16-invite-pending-1440-${theme}`)
  }
  check(boss.errors.length === 0, 'boss: no page errors' + (boss.errors.length ? ': ' + boss.errors.join(' | ') : ''))
  await boss.context().close()

  // a non-admin (kim, Editor of /프로젝트) is never offered an invitation
  const kim = await signedIn(browser, fx, 'kim')
  await kim.goto(fx.base + '/#/files?p=' + enc('/프로젝트'))
  await kim.locator('.fv-items > li', { hasText: '계획.md' }).click({ button: 'right' })
  await kim.locator('.fv-menu button', { hasText: 'Share' }).click()
  await kim.waitForSelector('.sd-combo')
  await kim.fill('.sd-combo input', 'someone@else.test')
  await kim.waitForTimeout(300)
  check(await kim.locator('.sd-options li.invite').count() === 0, 'a non-admin is not offered an invitation')
  await kim.context().close()

  // the address joins (the member sync applies pending shares)
  const j = await (await fetch(fx.hooks + '/join', { method: 'POST', body: JSON.stringify({ email: EMAIL, name: 'newbie' }) })).json()
  check(j.applied === 1, 'joining applied the pending share')
  const nb = await signedIn(browser, fx, { cookie: j.cookie })
  await nb.goto(fx.base + '/#/shared')
  await nb.waitForSelector('table.swm')
  const r = nb.locator('table.swm tr', { hasText: '이사회.md' })
  check(await r.count() === 1 && (await r.textContent()).includes('boss'), 'the new member finds 이사회.md in Shared with me (shared by boss)')
  await r.locator('a.swm-name').click()
  await nb.waitForSelector('.fv-detail')
  check(await nb.locator('.fv-items > li').count() === 1, '/경영 shows that file alone')
  await shot(nb, 's16-joined-1440-light')
  check(nb.errors.length === 0, 'newbie: no page errors' + (nb.errors.length ? ': ' + nb.errors.join(' | ') : ''))
  await nb.context().close()
}
