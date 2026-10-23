#!/usr/bin/env bun
// Writes test/fixtures/sso-v1.json: the SSO and member-sync contract between the Trina Cloud console (cloud/control,
// workstream D1) and a team's drive (src/tdcloud, workstream B1), with signed test vectors both sides run.
//   bun scripts/gen-sso-fixture.ts          write it
//   bun scripts/gen-sso-fixture.ts --check  exit 1 when the file differs from what this script makes
// Ed25519 is deterministic and the keys come from fixed seeds, so the output is the same on every run.
// The prose is docs/SSO-CONTRACT.md. Changing the contract = change this script, the doc, then both sides.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const FIXTURE = path.resolve(import.meta.dir, '..', 'test', 'fixtures', 'sso-v1.json')

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url')
const sha256b64u = (s: string) => b64u(crypto.createHash('sha256').update(s, 'utf8').digest())

/** A test-only Ed25519 key from a fixed seed (PKCS#8 prefix + 32-byte seed). */
function testKey(label: string) {
  const seed = crypto.createHash('sha256').update(`tdcloud-sso-v1 TEST ONLY ${label}`).digest()
  const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
  const x = (crypto.createPublicKey(priv).export({ format: 'jwk' }) as { x: string }).x
  return { seed: b64u(seed), priv, x }
}

export const SIGNING_PREFIX = 'tdcloud-sso-v1.'

function sign(payload: Record<string, unknown> | string, key: crypto.KeyObject) {
  const seg = typeof payload === 'string' ? b64u(Buffer.from(payload, 'utf8')) : b64u(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = crypto.sign(null, Buffer.from(SIGNING_PREFIX + seg, 'ascii'), key)
  return `v1.${seg}.${b64u(sig)}`
}

export function build() {
  const k1 = testKey('k1'), k2 = testKey('k2'), k9 = testKey('k9-not-configured')
  const ISS = 'https://cloud.trina.app'
  const TEAM = 'team_3f2a9c41d07be5a86c19'
  const OTHER_TEAM = 'team_0b7d2e55a1c94f3d8e60'
  const TEAM_URL = 'https://trina.cloud.trina.app'
  const IAT = 1761223456
  const NOW = IAT + 5
  const STATE = 'Q2hvb3NlIGEgbmV3IHN0YXRlIGV2ZXJ5IHRpbWUhIQ'
  const OTHER_STATE = 'T3RoZXIgYnJvd3NlciwgZGlmZmVyZW50IHN0YXRlISE'
  const jti = (n: number) => b64u(crypto.createHash('sha256').update(`jti ${n}`).digest().subarray(0, 16))

  const claims = (over: Record<string, unknown> = {}) => ({
    iss: ISS, aud: TEAM, kid: 'k1',
    sub: 'usr_9a41c2e07d5b3f8e6a10', email: 'mina@trina.app', name: 'Mina Kim', role: 'member',
    iat: IAT, nbf: IAT, exp: IAT + 60, auth_time: IAT - 600, jti: jti(1),
    state_hash: sha256b64u(STATE), amr: ['pwd'], sync_seq: 7,
    ...over,
  })

  const ok = (c: Record<string, unknown>) => ({ ok: true, claims: c })
  const err = (error: string) => ({ ok: false, error })
  type V = { name: string; why: string; now: number; state: string; cookie_state: string | null; assertion: string; seen_jti?: string[]; expect: unknown }
  const v = (name: string, why: string, assertion: string, expect: unknown, o: Partial<V> = {}): V =>
    ({ name, why, now: NOW, state: STATE, cookie_state: STATE, assertion, expect, ...o })

  const member = claims()
  const owner = claims({ sub: 'usr_1c0ffee0d15ea5e0b0a7', email: 'dion@trina.app', name: 'Dion Nam', role: 'owner', amr: ['pwd', 'totp'], jti: jti(2) })
  const reauth = claims({ jti: jti(3), auth_time: IAT - 2, amr: ['pwd', 'totp'] })
  const rotated = claims({ kid: 'k2', jti: jti(4) })
  const valid = sign(member, k1.priv)
  const [, validSeg, validSig] = valid.split('.')
  const tampered = `v1.${b64u(Buffer.from(JSON.stringify({ ...member, role: 'admin' }), 'utf8'))}.${validSig}`

  const vectors: V[] = [
    v('valid_member', 'a member signing in from the console', valid, ok(member)),
    v('valid_owner_totp', 'an owner whose console sign-in used a TOTP code', sign(owner, k1.priv), ok(owner)),
    v('valid_reauth', 'GET /api/sso/start?reauth=1 → max_age=0: auth_time is fresh', sign(reauth, k1.priv), ok(reauth)),
    v('valid_rotated_key', 'signed with k2 while both k1 and k2 are configured (key rotation)', sign(rotated, k2.priv), ok(rotated)),
    v('valid_at_skew_edge', 'now = exp + 60 s: still inside the allowed clock skew', sign(claims({ jti: jti(5) }), k1.priv), ok(claims({ jti: jti(5) })), { now: IAT + 60 + 60 }),
    v('expired', 'now = exp + 61 s', sign(claims({ jti: jti(6) }), k1.priv), err('expired'), { now: IAT + 60 + 61 }),
    v('iat_in_future', 'iat more than 60 s ahead of the drive\'s clock', sign(claims({ jti: jti(7), iat: NOW + 61, nbf: NOW + 61, exp: NOW + 121 }), k1.priv), err('not_yet_valid')),
    v('nbf_in_future', 'nbf more than 60 s ahead', sign(claims({ jti: jti(8), nbf: NOW + 61 }), k1.priv), err('not_yet_valid')),
    v('lifetime_too_long', 'exp - iat = 300 s (at most 120)', sign(claims({ jti: jti(9), exp: IAT + 300 }), k1.priv), err('bad_lifetime')),
    v('bad_signature', 'payload changed (role member → admin), signature of the original kept', tampered, err('bad_signature')),
    v('signature_of_other_payload', 'a valid signature moved onto another valid payload', `v1.${sign(owner, k1.priv).split('.')[1]}.${validSig}`, err('bad_signature')),
    v('unknown_kid', 'kid not in TDRIVE_CLOUD_SSO_KEYS', sign(claims({ kid: 'k9', jti: jti(10) }), k9.priv), err('unknown_kid')),
    v('kid_k1_signed_by_k2', 'kid says k1, k2 signed it', sign(claims({ jti: jti(11) }), k2.priv), err('bad_signature')),
    v('wrong_audience', 'an assertion for another team (team A\'s pass used at team B)', sign(claims({ aud: OTHER_TEAM, jti: jti(12) }), k1.priv), err('bad_audience')),
    v('wrong_issuer', 'iss is not TDRIVE_CLOUD_ISSUER', sign(claims({ iss: 'https://cloud.trina.app.evil.example', jti: jti(13) }), k1.priv), err('bad_issuer')),
    v('state_cookie_missing', 'no state cookie (another browser, or it expired)', valid, err('bad_state'), { cookie_state: null }),
    v('state_cookie_differs', 'the posted state is not this browser\'s', valid, err('bad_state'), { cookie_state: OTHER_STATE }),
    v('state_hash_differs', 'cookie and posted state agree, but the assertion was made for another state', sign(claims({ jti: jti(14), state_hash: sha256b64u(OTHER_STATE) }), k1.priv), err('bad_state')),
    v('replayed', 'the jti was used before (sso_used)', valid, err('replayed'), { seen_jti: [String(member.jti)] }),
    v('bad_prefix', 'v2 is not a version this drive knows', `v2.${validSeg}.${validSig}`, err('malformed')),
    v('not_three_parts', 'two segments only', `v1.${validSeg}`, err('malformed')),
    v('payload_not_json', 'the payload segment is not JSON', sign('not json', k1.priv), err('malformed')),
    v('missing_jti', 'a required claim is missing', sign(Object.fromEntries(Object.entries(claims({ jti: jti(15) })).filter(([k]) => k !== 'jti')), k1.priv), err('malformed')),
    v('bad_role', 'role is not owner | admin | member', sign(claims({ jti: jti(16), role: 'superadmin' }), k1.priv), err('malformed')),
    v('bad_sub', 'sub is not usr_ + 20 hex', sign(claims({ jti: jti(17), sub: '42' }), k1.priv), err('malformed')),
  ]

  return {
    $comment: 'GENERATED by scripts/gen-sso-fixture.ts — do not edit by hand. The SSO and member-sync contract between the Trina Cloud console (cloud/control, D1) and a team drive (src/tdcloud, B1). Prose: docs/SSO-CONTRACT.md. The private keys below are TEST ONLY (derived from public strings); production keys live in the control plane, wrapped by KMS.',
    contract: 'tdcloud-sso-v1',
    issuer: ISS,
    team: TEAM,
    team_url: TEAM_URL,
    env: {
      TDRIVE_CLOUD_ISSUER: ISS,
      TDRIVE_CLOUD_TEAM: TEAM,
      TDRIVE_CLOUD_SSO_KEYS: JSON.stringify([{ kid: 'k1', x: k1.x }, { kid: 'k2', x: k2.x }]),
      TDRIVE_CLOUD_CALLBACK_TOKEN: 'tdcb_' + b64u(crypto.createHash('sha256').update('test callback token').digest()),
      TDRIVE_CLOUD_CONSOLE_URL: ISS,
      TDRIVE_SSO_ONLY: '1',
    },
    test_keys: {
      $comment: 'TEST ONLY. Ed25519 private keys as base64url 32-byte seeds (PKCS#8 = 302e020100300506032b657004220420 || seed); x = base64url raw 32-byte public key (JWK OKP x).',
      k1: { seed: k1.seed, x: k1.x },
      k2: { seed: k2.seed, x: k2.x },
      k9: { seed: k9.seed, x: k9.x, configured: false },
    },
    assertion: {
      format: 'v1.<payload>.<signature>',
      payload: 'base64url (no padding) of the UTF-8 JSON claims object',
      signature: 'base64url (no padding) of the 64-byte Ed25519 signature over the ASCII bytes of "tdcloud-sso-v1." + <payload> (the base64url segment exactly as sent; no JSON canonicalization)',
      max_length: 4096,
      claims: {
        iss: 'string; == TDRIVE_CLOUD_ISSUER exactly',
        aud: 'string; == TDRIVE_CLOUD_TEAM (teams.public_id, team_ + 20 hex) exactly',
        kid: 'string; a kid in TDRIVE_CLOUD_SSO_KEYS',
        sub: 'string; ^usr_[0-9a-f]{20}$ (console users.public_id; never reused) → accounts.cloud_user',
        email: 'string; the console account\'s confirmed address',
        name: 'string; display name (may be "")',
        role: '"owner" | "admin" | "member" (console team_members.role); owner and admin → people.admin = 1',
        iat: 'integer seconds; issue time',
        nbf: 'integer seconds; = iat',
        exp: 'integer seconds; iat + 60',
        auth_time: 'integer seconds; when the person last typed their console password (and TOTP); fresh-login proof for ?reauth=1',
        jti: 'string; base64url of 16 random bytes (22 chars); accepted once (sso_used)',
        state_hash: 'string; base64url(SHA-256(UTF-8 state)) of the state the drive put in /sso/authorize',
        amr: 'array of "pwd" | "link" | "totp"; how the console session was authenticated',
        sync_seq: 'integer >= 0; the newest member-sync seq the console has made for this team when it signed (see member_sync.sso_rule)',
      },
      required: ['iss', 'aud', 'kid', 'sub', 'email', 'name', 'role', 'iat', 'nbf', 'exp', 'auth_time', 'jti', 'state_hash', 'amr', 'sync_seq'],
      clock: { ttl_s: 60, skew_s: 60, max_lifetime_s: 120, rules: ['not_yet_valid: iat > now + 60 or nbf > now + 60', 'expired: now > exp + 60', 'bad_lifetime: exp <= iat or exp - iat > 120', 'sso_used rows may be deleted after exp + 60'] },
      verify_order: [
        '1 bad_state: the state cookie is missing, or differs from the posted state (timing-safe compare)',
        '2 malformed: not ^v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$, longer than max_length, payload not a JSON object, a required claim missing or of the wrong shape (sub, role, jti, amr, integers)',
        '3 unknown_kid: kid not configured',
        '4 bad_signature: Ed25519 verify fails',
        '5 bad_issuer, 6 bad_audience',
        '7 not_yet_valid, expired, bad_lifetime (clock rules)',
        '8 bad_state: state_hash != base64url(sha256(state))',
        '9 replayed: jti already in sso_used (insert it in the same transaction as the sign-in)',
      ],
      errors: ['bad_state', 'malformed', 'unknown_kid', 'bad_signature', 'bad_issuer', 'bad_audience', 'not_yet_valid', 'expired', 'bad_lifetime', 'replayed'],
    },
    flow: {
      start: 'GET {team_url}/api/sso/start?return=<relative path>[&reauth=1] → the drive makes state = base64url(32 random bytes), keeps {sha256(state), return, reauth, created_at} server-side (10 min) and sets the state cookie; 303 → {issuer}/sso/authorize?team={team}&state=<state>[&max_age=0]',
      state_cookie: '__Host-tdrive_sso=<state>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600 (plain-http dev only: tdrive_sso without Secure / __Host-). cloud.trina.app and *.cloud.trina.app are the same site, so the Lax cookie comes back on the console\'s cross-origin POST.',
      return: 'only a relative path starting with "/" and not "//" (an OAuth consent URL /oauth/authorize?… included); it never goes to the console',
      authorize: 'GET {issuer}/sso/authorize?team&state[&max_age=0] (console). No console session → /login?next=<relative>. Not an active member of that team, or no such team → the same 404 page. max_age=0, or the session older than max_age → ask for the password (+ TOTP when enrolled; owners/admins must have TOTP). Then the callback URL is derived from the team record ({team_url}/api/sso/callback) — never from the query.',
      callback: 'The console answers 200 with a page that POSTs (form_post, auto-submit) to {team_url}/api/sso/callback, Content-Type application/x-www-form-urlencoded, fields assertion and state. The console CSP needs form-action \'self\' https://*.{domain}. The drive route is raw + crossOrigin (no Origin check): the state cookie and the signature prove it.',
      after: 'On success the drive revokes any session the browser came with, starts a new one (session fixation), deletes the stored state, and 303s to return (default /#/files). A person with a second factor on the drive (or a hosted admin) goes to /#/sso-second/<ticket> first. On an error: 303 /#/sso-error/<code> (code from assertion.errors, nothing else shown).',
      account: 'accounts.cloud_user = sub → else bind a person with cloud_user NULL and the same email (case-insensitive) → else JIT-create (name from the email\'s local part, -2, -3 on collision; display_name = name claim), subject to TDRIVE_MAX_PEOPLE. Role and reactivation follow member_sync.sso_rule.',
      reauth: 'When the stored state had reauth=1 and now - auth_time <= 120, the drive marks the new session freshly authenticated (markReauth).',
    },
    vectors,
    member_sync: {
      transport: 'driver.exec(host, slug, [\'cloud\', \'sync-members\', \'--json\', <base64url(JSON)>]); the drive also accepts --stdin (raw JSON on stdin; plan S/G2). One JSON line out on stdout.',
      payload: {
        version: 2,
        team: TEAM,
        seq: 8,
        at: 1761223500000,
        members: [
          { cloud_user: 'usr_1c0ffee0d15ea5e0b0a7', invite: null, email: 'dion@trina.app', name: 'Dion Nam', role: 'owner', status: 'active' },
          { cloud_user: 'usr_9a41c2e07d5b3f8e6a10', invite: null, email: 'mina@trina.app', name: 'Mina Kim', role: 'member', status: 'active' },
          { cloud_user: null, invite: 'inv_000000000017', email: 'jae@partner.example', name: '', role: 'member', status: 'invited' },
        ],
        events: [
          { id: 'evt_00000000000000000041', type: 'member.removed', cloud_user: 'usr_7e2d0c4a9b1f5e3d2c18', at: 1761223499000 },
          { id: 'evt_00000000000000000042', type: 'member.sessions_revoked', cloud_user: 'usr_9a41c2e07d5b3f8e6a10', at: 1761223499500, reason: 'console_password_changed' },
          { id: 'evt_00000000000000000043', type: 'invite.revoked', invite: 'inv_000000000016', at: 1761223499800 },
        ],
      },
      fields: {
        version: '2 (v1 had no seq/events; a drive refuses other versions with error bad_version)',
        team: '== TDRIVE_CLOUD_TEAM, else error wrong_team',
        seq: 'per-team, strictly increasing integer the console assigns when it builds a payload (teams.sync_seq). The drive applies a payload only when seq > meta.cloud_sync_seq, then stores seq in the same transaction',
        at: 'ms since epoch, when the console built it (informational)',
        members: 'the WHOLE desired state: every active member and open invite of the team. cloud_user null only for status invited; invite set while the person has not accepted (and kept once, on the first payload after acceptance, to link the invited row)',
        events: 'things a desired state cannot say, applied after the members in the same transaction; idempotent by id (a drive keeps the ids it applied for 30 days)',
      },
      apply: [
        'members with cloud_user: find the person by accounts.cloud_user, else by accounts.cloud_invite = invite, else by email with cloud_user NULL; create when none (JIT rules as in flow.account). Set cloud_user, email, display name, admin = role in (owner, admin), active = 1',
        'members with status invited: a person row (active = 1, no password, accounts.cloud_invite = invite) so the share dialog can grant access before they sign up; not in Everyone until active',
        'every person with a cloud_user or cloud_invite who is NOT in members: deactivate — active = 0, sessions revoked, PATs revoked (revokeTokensOf), OAuth grants revoked, app passwords deleted. An invite no longer listed: its row is deactivated the same way',
        'people with neither cloud_user nor cloud_invite (made by the CLI, break-glass, setup) are never changed; they are reported in unmanaged',
        'Everyone (cloud mode: a system group) = exactly the active members; the drive API cannot edit it (409 managed_by_console)',
        'a person becoming admin here (was not) → notice to every other active admin and to the person, and an audit row',
      ],
      event_types: {
        'member.removed': 'deactivate that cloud_user as in apply (also when the members list already lacks them; makes the removal explicit in the audit)',
        'member.sessions_revoked': 'revoke that person\'s web sessions only (console password change, "sign out everywhere"); tokens and membership stay',
        'invite.revoked': 'deactivate the invited row of that invite',
      },
      output_applied: { ok: true, applied: true, seq: 8, created: 1, updated: 0, deactivated: 1, reactivated: 0, people: 3, unmanaged: [{ name: 'ops-breakglass', admin: true, active: true }] },
      output_stale: { ok: true, applied: false, seq: 8, current_seq: 9, reason: 'stale' },
      output_error: { ok: false, error: 'bad_version | wrong_team | bad_json | people_limit', message: 'text' },
      exit_codes: { '0': 'applied or stale (the console marks the job done)', '1': 'error (the console retries with backoff until it succeeds; a removal is shown in red in Members until then)' },
      sso_rule: [
        'Let applied = meta.cloud_sync_seq (0 when none). An assertion is "newer" when assertion.sync_seq > applied.',
        'No person row for sub/email: JIT-create (the console vouches for membership now).',
        'Person inactive (active = 0): reactivate only when the assertion is newer (the console\'s view is fresher than the last sync); otherwise refuse with error deactivated. Reactivation never brings back old tokens (they were revoked when deactivated).',
        'Person active: set admin from role only when the assertion is newer; otherwise keep the drive\'s value (the sync will correct it).',
        'This is the clock-free form of plan 10.2 #5 "iat < last_sync_applied_at → do not reactivate".',
      ],
      vectors: [
        { name: 'apply_newer', applied_before: 7, payload_seq: 8, expect: { applied: true, applied_after: 8 } },
        { name: 'same_seq_is_stale', applied_before: 8, payload_seq: 8, expect: { applied: false, reason: 'stale', applied_after: 8 } },
        { name: 'older_is_stale', applied_before: 9, payload_seq: 8, expect: { applied: false, reason: 'stale', applied_after: 9 } },
        { name: 'sso_inactive_older_assertion', applied_before: 8, person: 'inactive', assertion_sync_seq: 7, expect: { sign_in: false, error: 'deactivated' } },
        { name: 'sso_inactive_same_seq', applied_before: 8, person: 'inactive', assertion_sync_seq: 8, expect: { sign_in: false, error: 'deactivated' } },
        { name: 'sso_inactive_newer_assertion', applied_before: 8, person: 'inactive', assertion_sync_seq: 9, expect: { sign_in: true, reactivated: true } },
        { name: 'sso_active_role_from_newer', applied_before: 8, person: 'active member', assertion_sync_seq: 9, assertion_role: 'admin', expect: { sign_in: true, admin: true } },
        { name: 'sso_active_role_kept_when_older', applied_before: 8, person: 'active member', assertion_sync_seq: 8, assertion_role: 'admin', expect: { sign_in: true, admin: false } },
        { name: 'sso_unknown_person_jit', applied_before: 8, person: 'none', assertion_sync_seq: 3, expect: { sign_in: true, created: true } },
      ],
    },
    callback_invite: {
      request: `POST ${ISS}/api/team-callback/invites, Authorization: Bearer <TDRIVE_CLOUD_CALLBACK_TOKEN>, Content-Type: application/json`,
      body: { email: 'jae@partner.example', role: 'member', by_cloud_user: 'usr_9a41c2e07d5b3f8e6a10' },
      rules: [
        'The console keeps only sha256(token) (teams.callback_hash), rotated whenever it writes the team env (same transaction)',
        'role must be "member" (admins are invited in the console only) → else 400 bad_role',
        'by_cloud_user must be an active admin/owner of that team in the console right now → else 403 not_admin',
        'at most 50 per team per day → 429 rate_limited',
        'the console creates the invite (or reuses the open one for that email), mails it, and queues sync_members',
      ],
      response_201: { status: 'invited', invite: 'inv_000000000017' },
      errors: { '400': 'bad_role | bad_email', '401': 'bad_token', '403': 'not_admin', '429': 'rate_limited' },
    },
    usage: {
      transport: 'driver.exec(host, slug, [\'cloud\', \'usage\', \'--json\']) hourly (with the Free activity poll)',
      output: { people: 7, ai_people_30d: 4, files_bytes: 1234567890, trash_bytes: 1234567, versions_bytes: 7654321, quota_bytes: 107374182400, last_activity_at: 1761223400000 },
    },
  }
}

export const render = () => JSON.stringify(build(), null, 2) + '\n'

if (import.meta.main) {
  const out = render()
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(FIXTURE) || fs.readFileSync(FIXTURE, 'utf8') !== out) { console.error(`${FIXTURE} is stale: run bun scripts/gen-sso-fixture.ts`); process.exit(1) }
    console.log('sso-v1.json is up to date')
  } else {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true })
    fs.writeFileSync(FIXTURE, out)
    console.log(`wrote ${FIXTURE}`)
  }
}
