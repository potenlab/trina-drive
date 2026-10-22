// Screen text of the OAuth consent page and the public address, English and Korean (kept apart from i18n.ts).
// Korean must have every English key (TypeScript checks it).
import { getLocale } from '../i18n'

const en = {
  title: '{name} wants to connect',
  domain_label: 'App address',
  domain_checked: 'Checked: the app\'s details were fetched from this address over HTTPS.',
  domain_unverified: 'Not verified: the app registered itself and chose this name. Approve only if you started this connection just now.',
  answer_to: 'The answer goes to',
  loopback_warn: 'The answer goes to a program on this computer (localhost). Any program here could claim to be this app; approve only if you started it.',
  signed_in_as: 'Signed in as {name}',
  only_if_you: 'Allow only if you started this connection from the app just now. A link someone sent you can ask to connect THEIR app to YOUR folders.',
  what_it_gets: 'What the app may do',
  folders: 'Folders',
  folders_all: 'Everything my AI may read',
  folders_some: 'Only these folders',
  folders_admin: 'As an admin, pick the folders this app may read.',
  folders_none: 'No folders are open to your AI. Ask your admin.',
  read_only: 'Read only (recommended)',
  read_only_off: 'Also write drafts to /drafts (originals are never changed)',
  write_not_asked: 'This app asked to read only.',
  expiry: 'Connection ends after',
  ttl_1d: '1 day', ttl_7d: '7 days', ttl_30d: '30 days', ttl_90d: '90 days',
  notes: 'What the app reads goes to the AI company that runs it ({domain}). Folders marked "No AI" stay closed. You can cut this connection any time under My tokens; it stops on the next request.',
  approve: 'Allow', deny: 'Deny',
  gone: 'This connection request is used or expired. Start again from the AI app.',
  redirecting: 'Going back to the app…',
  public_title: 'Connecting AI apps',
  public_text: 'This address is only for connecting AI apps (claude.ai, ChatGPT) and approving them. Manage folders, people and tokens at the office address.',
  public_signed_in: 'You are signed in as {name}.',
}

type Key = keyof typeof en

const ko: Record<Key, string> = {
  title: '{name}이(가) 연결을 요청합니다',
  domain_label: '앱 주소',
  domain_checked: '확인됨: 이 주소에서 HTTPS로 앱 정보를 받아 왔습니다.',
  domain_unverified: '확인 안 됨: 앱이 스스로 등록하며 이 이름을 붙였습니다. 방금 직접 연결을 시작했을 때만 허용하세요.',
  answer_to: '응답이 가는 곳',
  loopback_warn: '응답이 이 컴퓨터의 프로그램(localhost)으로 갑니다. 이 컴퓨터의 어떤 프로그램이든 이 앱인 척할 수 있으니, 직접 시작했을 때만 허용하세요.',
  signed_in_as: '{name}(으)로 로그인됨',
  only_if_you: '방금 그 앱에서 직접 연결을 시작했을 때만 허용하세요. 남이 보낸 링크는 그 사람의 앱을 내 폴더에 연결하라는 요청일 수 있습니다.',
  what_it_gets: '앱이 할 수 있는 일',
  folders: '폴더',
  folders_all: '내 AI가 읽을 수 있는 전부',
  folders_some: '고른 폴더만',
  folders_admin: '관리자는 이 앱이 읽을 폴더를 직접 골라야 합니다.',
  folders_none: '내 AI에게 열린 폴더가 없습니다. 관리자에게 물어보세요.',
  read_only: '읽기만 (권장)',
  read_only_off: '/drafts에 초안 쓰기도 허용 (원본은 바뀌지 않음)',
  write_not_asked: '이 앱은 읽기만 요청했습니다.',
  expiry: '연결 유지 기간',
  ttl_1d: '1일', ttl_7d: '7일', ttl_30d: '30일', ttl_90d: '90일',
  notes: '앱이 읽은 내용은 그 앱을 운영하는 AI 회사({domain})로 갑니다. "AI 연결 금지" 폴더는 그대로 닫혀 있습니다. 이 연결은 "내 토큰"에서 언제든 끊을 수 있고, 다음 요청부터 바로 막힙니다.',
  approve: '허용', deny: '거절',
  gone: '이미 처리했거나 만료된 연결 요청입니다. AI 앱에서 다시 시작하세요.',
  redirecting: '앱으로 돌아가는 중…',
  public_title: 'AI 앱 연결',
  public_text: '이 주소는 AI 앱(claude.ai, ChatGPT) 연결과 그 허용에만 쓰입니다. 폴더·사람·토큰 관리는 사무실 주소에서 하세요.',
  public_signed_in: '{name}(으)로 로그인되어 있습니다.',
}

export function ct(key: Key, params?: Record<string, string | number>): string {
  const s = (getLocale() === 'ko' ? ko : en)[key] ?? en[key]
  return params ? s.replace(/\{(\w+)\}/g, (all, k: string) => (params[k] !== undefined ? String(params[k]) : all)) : s
}
export type ConsentKey = Key
