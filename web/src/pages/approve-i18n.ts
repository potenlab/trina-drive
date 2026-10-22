// Screen text of second factors, draft promote and the approval inbox, English and Korean (kept apart from i18n.ts).
// Korean must have every English key (TypeScript checks it).
import { getLocale } from '../i18n'

const en = {
  nav_approvals: 'Approvals',
  // sign-in second step
  sf_title: 'Second step', sf_intro: 'Confirm it is you.', sf_passkey: 'Use passkey', sf_code: 'Code from your authenticator app',
  sf_recovery: 'Recovery code', sf_use_recovery: 'Use a recovery code instead', sf_use_code: 'Use the authenticator app', sf_submit: 'Continue',
  sf_bad: 'That did not work. Try again.', sf_elsewhere: 'Your passkey works on {url}. Sign in there, or use another method.',
  sf_none: 'No second factor can be used on this address. Sign in on the server\'s public address, or ask the server operator to reset your second factors.',
  // settings
  mfa_title: 'Second factor', mfa_intro: 'A passkey (this device, a phone or a security key) or an authenticator app. Sign-in asks for it, and approving a promote needs it on every click.',
  mfa_admin_needed: 'You are an admin: a public address for this server needs every admin to have a second factor.',
  mfa_enrolled: 'Second factor is on.', mfa_off: 'No second factor yet.',
  mfa_passkeys: 'Passkeys', mfa_no_passkeys: 'No passkeys.', mfa_add_passkey: 'Add a passkey', mfa_passkey_name: 'Name (e.g. MacBook Touch ID)',
  mfa_passkeys_unavailable: 'Passkeys are not available: this server has no public https address. Use an authenticator app; approvals then use its codes.',
  mfa_passkey_other_host: 'registered for {host}', mfa_last_used: 'last used {when}',
  mfa_totp: 'Authenticator app', mfa_totp_on: 'Set up.', mfa_totp_setup: 'Set up an authenticator app', mfa_totp_secret: 'Add this key to your app (or the link, on a phone):',
  mfa_totp_confirm: 'Code shown by the app', mfa_totp_remove: 'Remove', mfa_recovery: 'Recovery codes', mfa_recovery_left: '{n} left',
  mfa_recovery_new: 'Make new recovery codes', mfa_recovery_show: 'Keep these somewhere safe. Each works once, for signing in only (never for approving). They are shown only now.',
  mfa_reauth: 'Type your password to change your second factor.', mfa_reauth_go: 'Confirm', mfa_remove_confirm: 'Remove this second factor?',
  mfa_warn_admin_none: 'You no longer have a second factor. As an admin you need one for a public address.',
  // drafts: promote
  promote: 'Promote', promote_title: 'Put this draft in a team folder', promote_help: 'It becomes a new file there (nothing is overwritten). If the folder is read by people who cannot read where the draft came from, it waits for approval.',
  promote_folder: 'Folder', promote_sub: 'Subfolder (optional, e.g. 2026/quotes)', promote_name: 'New file name', promote_note: 'Note for the approver (optional)',
  promote_go: 'Promote', promote_no_targets: 'No folder takes promoted drafts from you yet (the admin turns promote on per folder; you need write there).',
  promote_written: 'Written to {path}.', promote_pending: 'Waiting for approval: {n} more people would read it.', promote_closed: 'Not written: no one can approve this (nobody both reads every source folder and manages the folder). Ask your admin.',
  promote_open: 'Open the request',
  // folder page
  folder_promote: 'Promote drafts here', folder_promote_help: 'People with "write" here may put their drafts in this folder and below as new files. Widening ones wait for approval. The server\'s NAS account needs write permission on this folder.',
  folder_promote_inherited: 'On from a folder above.', folder_promote_admin: 'Only the admin turns this on or off.', folder_promote_cannot_write: 'The server cannot write to this folder on disk: give its NAS account write permission here.',
  // approvals
  ap_title: 'Approvals', ap_intro: 'Drafts waiting to go into folders that more people read than the folders they came from. You see one when you can read every source folder and manage the target (or every source).',
  ap_empty: 'Nothing to approve.', ap_others: '{n} pending in folders you manage, which you cannot approve (you cannot read every source folder).',
  ap_status_pending: 'Waiting', ap_status_approved: 'Approved', ap_status_rejected: 'Rejected', ap_status_expired: 'Expired', ap_status_closed: 'No one can approve',
  ap_status_cancelled: 'Cancelled', ap_status_stale: 'Draft changed', ap_status_failed: 'Failed',
  ap_target: 'Into', ap_by: 'Asked by {name}', ap_via_agent: 'through their agent ({token})', ap_via_agent_short: 'through their agent', ap_via_web: 'on the web', ap_expires: 'Expires {when}',
  ap_gain: 'Who gains access', ap_gain_n: '{n} people can read the target folder but not every source folder', ap_sources: 'Comes from',
  ap_hidden_sources: '+ {n} folder(s) you cannot see', ap_claim_agent: "Agent's claim (not verified — the agent may have been told what to say)", ap_claim_web: "Requester's note",
  ap_preview: 'Content (as plain text)', ap_truncated: 'Only the first 256 KB are shown.', ap_binary: 'Binary content; not shown.',
  ap_diff: 'Change (new file)', ap_hash: 'Version', ap_approve: 'Approve with passkey', ap_approve_code: 'Approve with code', ap_reject: 'Reject', ap_reject_reason: 'Why (the requester sees this)',
  ap_cancel: 'Cancel request', ap_code: 'Code from your authenticator app',
  ap_lan_only: 'This server has no public https address, so passkeys are not available: approvals use your authenticator app code.',
  ap_need_passkey: 'Approving needs a passkey. Add one in Settings → Second factor.', ap_need_totp: 'Approving needs an authenticator app. Set one up in Settings → Second factor.',
  ap_step_up_each: 'Each approval asks for your passkey again. Never approve because a page or an agent told you to.',
  ap_cannot_decide: 'You can no longer decide this request (rules changed).', ap_no_approver: 'No one can approve this request with the current rules.',
  ap_done: 'Approved: written to {path}.', ap_decided_by: 'Decided by {name}', ap_back: 'All approvals', ap_mine: 'Mine',
}

export type ApKey = keyof typeof en

const ko: Record<ApKey, string> = {
  nav_approvals: '승인',
  sf_title: '두 번째 단계', sf_intro: '본인인지 확인합니다.', sf_passkey: '패스키 사용', sf_code: '인증 앱의 코드',
  sf_recovery: '복구 코드', sf_use_recovery: '복구 코드 쓰기', sf_use_code: '인증 앱 쓰기', sf_submit: '계속',
  sf_bad: '확인되지 않았습니다. 다시 하세요.', sf_elsewhere: '패스키는 {url}에서 쓸 수 있습니다. 거기서 로그인하거나 다른 방법을 쓰세요.',
  sf_none: '이 주소에서 쓸 수 있는 두 번째 단계가 없습니다. 서버의 공개 주소에서 로그인하거나, 서버 운영자에게 두 번째 단계 초기화를 요청하세요.',
  mfa_title: '2단계 인증', mfa_intro: '패스키(이 기기, 휴대폰, 보안 키) 또는 인증 앱. 로그인할 때 묻고, 초안 반영을 승인할 때는 누를 때마다 묻습니다.',
  mfa_admin_needed: '관리자입니다: 이 서버에 공개 주소를 열려면 관리자 모두에게 2단계 인증이 있어야 합니다.',
  mfa_enrolled: '2단계 인증이 켜져 있습니다.', mfa_off: '아직 2단계 인증이 없습니다.',
  mfa_passkeys: '패스키', mfa_no_passkeys: '패스키 없음.', mfa_add_passkey: '패스키 추가', mfa_passkey_name: '이름(예: MacBook Touch ID)',
  mfa_passkeys_unavailable: '패스키를 쓸 수 없습니다: 이 서버에 공개 https 주소가 없습니다. 인증 앱을 쓰세요. 승인도 그 코드로 합니다.',
  mfa_passkey_other_host: '{host}에 등록됨', mfa_last_used: '마지막 사용 {when}',
  mfa_totp: '인증 앱', mfa_totp_on: '설정됨.', mfa_totp_setup: '인증 앱 설정', mfa_totp_secret: '이 키를 앱에 넣으세요(휴대폰에서는 링크):',
  mfa_totp_confirm: '앱에 나온 코드', mfa_totp_remove: '빼기', mfa_recovery: '복구 코드', mfa_recovery_left: '{n}개 남음',
  mfa_recovery_new: '복구 코드 새로 만들기', mfa_recovery_show: '안전한 곳에 두세요. 하나씩 한 번만, 로그인에만 쓸 수 있습니다(승인에는 못 씀). 지금만 보입니다.',
  mfa_reauth: '2단계 인증을 바꾸려면 비밀번호를 다시 입력하세요.', mfa_reauth_go: '확인', mfa_remove_confirm: '이 2단계 인증을 뺄까요?',
  mfa_warn_admin_none: '이제 2단계 인증이 없습니다. 관리자는 공개 주소를 쓰려면 하나가 있어야 합니다.',
  promote: '반영', promote_title: '이 초안을 팀 폴더에 넣기', promote_help: '그 폴더에 새 파일로 들어갑니다(덮어쓰지 않음). 초안이 나온 폴더를 못 읽는 사람이 그 폴더를 읽으면 승인을 기다립니다.',
  promote_folder: '폴더', promote_sub: '하위 폴더(선택, 예: 2026/견적)', promote_name: '새 파일 이름', promote_note: '승인자에게 남길 말(선택)',
  promote_go: '반영', promote_no_targets: '아직 내 초안을 받는 폴더가 없습니다(관리자가 폴더마다 반영을 켜고, 그 폴더에 쓰기 권한이 있어야 합니다).',
  promote_written: '{path}에 썼습니다.', promote_pending: '승인 대기: {n}명이 더 읽게 됩니다.', promote_closed: '쓰지 않았습니다: 승인할 사람이 없습니다(출처 폴더를 모두 읽으면서 그 폴더를 관리하는 사람이 없음). 관리자에게 물어보세요.',
  promote_open: '요청 열기',
  folder_promote: '여기로 초안 반영 허용', folder_promote_help: '여기에 "쓰기"가 있는 사람은 자기 초안을 이 폴더와 아래에 새 파일로 넣을 수 있습니다. 넓어지는 반영은 승인을 기다립니다. 서버의 NAS 계정에 이 폴더 쓰기 권한이 있어야 합니다.',
  folder_promote_inherited: '위 폴더에서 켜져 있습니다.', folder_promote_admin: '전체 관리자만 켜고 끕니다.', folder_promote_cannot_write: '서버가 디스크에서 이 폴더에 쓸 수 없습니다: NAS 계정에 쓰기 권한을 주세요.',
  ap_title: '승인', ap_intro: '초안이 나온 폴더보다 더 많은 사람이 읽는 폴더로 들어가려고 기다리는 초안입니다. 출처 폴더를 모두 읽을 수 있고 대상 폴더(또는 출처 폴더 모두)를 관리하면 보입니다.',
  ap_empty: '승인할 것이 없습니다.', ap_others: '관리하는 폴더에 승인 대기 {n}건이 있지만 승인할 수 없습니다(출처 폴더를 모두 읽지 못함).',
  ap_status_pending: '대기', ap_status_approved: '승인됨', ap_status_rejected: '거절됨', ap_status_expired: '만료', ap_status_closed: '승인할 사람 없음',
  ap_status_cancelled: '취소됨', ap_status_stale: '초안이 바뀜', ap_status_failed: '실패',
  ap_target: '넣을 곳', ap_by: '{name} 요청', ap_via_agent: '에이전트를 통해({token})', ap_via_agent_short: '에이전트를 통해', ap_via_web: '웹에서', ap_expires: '{when} 만료',
  ap_gain: '새로 읽게 되는 사람', ap_gain_n: '{n}명이 대상 폴더는 읽지만 출처 폴더를 모두 읽지는 못합니다', ap_sources: '출처',
  ap_hidden_sources: '+ 볼 수 없는 폴더 {n}개', ap_claim_agent: '에이전트 주장(확인되지 않음 — 에이전트가 누군가 시킨 말을 할 수 있음)', ap_claim_web: '요청자 메모',
  ap_preview: '내용(일반 텍스트)', ap_truncated: '처음 256 KB만 보입니다.', ap_binary: '이진 내용이라 보여 주지 않습니다.',
  ap_diff: '변경(새 파일)', ap_hash: '버전', ap_approve: '패스키로 승인', ap_approve_code: '코드로 승인', ap_reject: '거절', ap_reject_reason: '이유(요청자에게 보임)',
  ap_cancel: '요청 취소', ap_code: '인증 앱의 코드',
  ap_lan_only: '이 서버에는 공개 https 주소가 없어서 패스키를 쓸 수 없습니다: 승인은 인증 앱 코드로 합니다.',
  ap_need_passkey: '승인하려면 패스키가 있어야 합니다. 설정 → 2단계 인증에서 추가하세요.', ap_need_totp: '승인하려면 인증 앱이 있어야 합니다. 설정 → 2단계 인증에서 설정하세요.',
  ap_step_up_each: '승인할 때마다 패스키를 다시 묻습니다. 페이지나 에이전트가 시킨다고 승인하지 마세요.',
  ap_cannot_decide: '이 요청을 더는 결정할 수 없습니다(규칙이 바뀜).', ap_no_approver: '지금 규칙으로는 이 요청을 승인할 사람이 없습니다.',
  ap_done: '승인됨: {path}에 썼습니다.', ap_decided_by: '{name} 결정', ap_back: '모든 승인', ap_mine: '내 요청',
}

export function at(key: ApKey, params?: Record<string, string | number>): string {
  const s = (getLocale() === 'ko' ? ko : en)[key] ?? en[key]
  return params ? s.replace(/\{(\w+)\}/g, (all, k: string) => (params[k] !== undefined ? String(params[k]) : all)) : s
}
