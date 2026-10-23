// Trina Cloud mode, SSO only (fixture --cloud): the frame's "Back to console"; People invites through the console
// (POST /api/cloud/invite) and person rows are read-only; console people have no "Change password" and make an app
// password through "Confirm it is you" (reauth_required → ReauthBox) instead of typing a password.
import { check, shot, signedIn } from './lib.mjs'

export async function cloudUi(browser, fx) {
  console.log('Cloud SSO-only: Back to console, People via the console, no password for console people, app password re-auth')
  const boss = await signedIn(browser, fx, 'boss')
  await boss.goto(fx.base + '/#/files')
  await boss.click('.acct-btn')
  check(await boss.locator('.acct-console').getAttribute('href') === 'http://console.test', 'account menu: Back to console → the console URL from config')
  await boss.keyboard.press('Escape')
  await boss.goto(fx.base + '/#/people')
  await boss.waitForSelector('.page')
  check(await boss.locator('form', { hasText: 'Invite to the team' }).count() === 1 && await boss.locator('form', { hasText: 'Add a person' }).count() === 0, 'People: invite by mail through the console, no local Add a person')
  check(await boss.locator('button', { hasText: /Make admin|Deactivate|Reset password|Change mail/ }).count() === 0, 'People: person edits are read-only')
  check(await boss.locator('.row-actions', { hasText: 'Managed in the Trina Cloud console' }).count() >= 1, 'People: rows say "Managed in the Trina Cloud console"')
  let posted = null
  await boss.route('**/api/cloud/invite', (r) => { posted = r.request().postDataJSON(); r.fulfill({ status: 201, contentType: 'application/json', body: '{"status":"invited"}' }) })
  await boss.fill('form:has-text("Invite to the team") input[type=email]', 'newbie@trina.test')
  await boss.locator('button', { hasText: 'Send invitation' }).click()
  await boss.locator('.ok', { hasText: 'Invitation sent to newbie@trina.test.' }).waitFor()
  check(JSON.stringify(posted) === JSON.stringify({ email: 'newbie@trina.test' }), 'People: POST /api/cloud/invite {email} (the role is the console’s: member)')
  await shot(boss, 'cloud-people-1440-light')
  await boss.context().close()

  const mina = await signedIn(browser, fx, 'mina')
  await mina.goto(fx.base + '/#/settings')
  await mina.waitForSelector('.page')
  check(await mina.locator('h2', { hasText: 'Change password' }).count() === 0, 'Settings: no Change password for a console person')
  await mina.goto(fx.base + '/#/mount')
  await mina.waitForSelector('.mount-new')
  check(await mina.locator('.mount-new input[type=password]').count() === 0, 'Mount: no password field for a console person')
  // the session here is fresh, so the server would not ask; answer the first try as a stale session does
  let asked = 0
  await mina.route('**/api/me/app-passwords', (r) => r.request().method() === 'POST' && asked++ === 0
    ? r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'reauth_required', message: 'prove it is you again' }) })
    : r.fallback())
  await mina.fill('.mount-new input', 'Work MacBook')
  await mina.locator('.mount-new button', { hasText: 'Create' }).click()
  await mina.locator('.mount [role=group] h3').waitFor()
  check(await mina.locator('.mount [role=group] a.btn').count() >= 1, 'Mount: reauth_required → Confirm it is you, with the console round trip')
  await shot(mina, 'cloud-mount-reauth-1440-light')
  check(mina.errors.length === 0, 'no page errors' + (mina.errors.length ? ': ' + mina.errors.join(' | ') : ''))
  await mina.context().close()
}
