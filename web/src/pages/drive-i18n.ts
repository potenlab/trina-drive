// Screen text of "Import from Google Drive" and "Mount as a drive", English and Korean (Korean must have every key).
import { getLocale } from '../i18n'

const en = {
  // Google Drive import
  gd_import: 'Import from Google Drive', gd_title: 'Google Drive', gd_connect: 'Connect Google Drive', gd_disconnect: 'Disconnect Google Drive',
  gd_connected_as: 'Connected as {email}', gd_connected: 'Connected', gd_broken: 'Google no longer accepts this connection. Connect again.',
  gd_help: 'Pick files in Google Drive and they are copied into a team folder you can edit. Google Docs, Sheets and Slides come in as Word, Excel and PowerPoint files. Importing the same file into the same folder again updates it as a new version.',
  gd_help_files: 'Trina sees only the files you pick (Google’s “drive.file” access), never the rest of your Drive.',
  gd_help_folders: 'On this server you can also pick whole folders; everything inside them is imported.',
  gd_disconnect_help: 'Disconnecting removes Trina’s access at Google too. Files already imported stay.',
  gd_confirm_disconnect: 'Disconnect Google Drive? Trina’s access is removed at Google as well. Imported files stay.',
  gd_disconnected: 'Google Drive disconnected.', gd_now_connected: 'Google Drive connected. Pick files to import.', gd_pick: 'Pick files',
  gd_back_denied: 'Google Drive was not connected (you said no at Google).', gd_back_failed: 'Connecting Google Drive failed. Try again.',
  gd_back_expired: 'That sign-in took too long or was opened in another browser. Try again.', gd_back_no_scope: 'Google Drive access was not ticked on Google’s page, so nothing was connected. Try again and tick it.',
  gd_picker_failed: 'The Google Drive picker could not open (is a blocker stopping apis.google.com?).',
  gd_importing_n: 'Importing {n} from Google Drive…', gd_done: 'Google Drive import done', gd_into: 'into {folder}',
  gd_st_queued: 'waiting', gd_st_importing: 'importing…', gd_st_imported: 'imported', gd_st_updated: 'updated (new version)', gd_st_unchanged: 'unchanged', gd_st_folder: 'folder',
  gd_summary: '{imported} new · {updated} updated · {unchanged} unchanged · {failed} failed',
  // mount (WebDAV)
  mt_title: 'Mount as a drive', mt_help: 'Open your team folders in Finder or Windows Explorer like a network drive. You see and change exactly what you can on the web; every change keeps versions and goes to the trash when deleted.',
  mt_address: 'Server address', mt_user: 'User name', mt_password: 'Password', mt_use_app_password: 'an app password (below)',
  mt_mac: 'Mac (Finder)', mt_mac_steps: 'In Finder choose Go → Connect to Server (⌘K).|Enter the server address above and choose Connect.|Choose “Registered User”, enter your user name and an app password, and tick “Remember this password”.',
  mt_win: 'Windows (File Explorer)', mt_win_steps: 'Open File Explorer, right-click “This PC” and choose “Map network drive…”.|Pick a letter, paste the server address above as the folder, tick “Connect using different credentials”, Finish.|Enter your user name and an app password.',
  mt_win_note: 'Windows copies files of at most 50 MB over a mounted drive unless its WebClient limit is raised; use the web for bigger files.',
  mt_notes: 'Only team folders kept on this server appear (folders that live on a NAS are not on the drive). Files your Mac or Office make for themselves (.DS_Store, ._ files, ~$ lock files) are never stored.',
  mt_not_https: 'This address is not https. Drives mount only over https (or on this computer itself).',
  mt_off: 'Mounting is not available on this server (it needs files kept on the server).',
  mt_app_passwords: 'App passwords', mt_app_help: 'Make one for each computer. It works only for mounting, only for you, and you can revoke it any time. Agents never use these (they connect with tokens).',
  mt_new: 'New app password', mt_name: 'Which computer', mt_name_ph: 'e.g. Work MacBook', mt_confirm_pw: 'Your password (to confirm it is you)',
  mt_create: 'Create', mt_shown_once: 'Copy it now: it is shown only once.', mt_none: 'No app passwords yet.', mt_revoke: 'Revoke',
  mt_last_used: 'last used {date}', mt_never_used: 'never used', mt_created: 'made {date}', mt_confirm_revoke: 'Revoke “{name}”? That computer is signed out of the drive.',
}

const ko: Record<keyof typeof en, string> = {
  gd_import: 'Google Drive에서 가져오기', gd_title: 'Google Drive', gd_connect: 'Google Drive 연결', gd_disconnect: 'Google Drive 연결 끊기',
  gd_connected_as: '{email} 계정으로 연결됨', gd_connected: '연결됨', gd_broken: 'Google이 이 연결을 더 받지 않습니다. 다시 연결하세요.',
  gd_help: 'Google Drive에서 파일을 고르면 내가 편집할 수 있는 팀 폴더로 복사됩니다. Google 문서·스프레드시트·프레젠테이션은 Word·Excel·PowerPoint 파일로 들어옵니다. 같은 파일을 같은 폴더로 다시 가져오면 새 버전으로 바뀝니다.',
  gd_help_files: 'Trina는 내가 고른 파일만 봅니다(Google의 “drive.file” 권한). 나머지 Drive는 보지 않습니다.',
  gd_help_folders: '이 서버에서는 폴더도 통째로 고를 수 있습니다. 그 안의 파일이 모두 들어옵니다.',
  gd_disconnect_help: '연결을 끊으면 Google 쪽 권한도 지웁니다. 이미 가져온 파일은 그대로 있습니다.',
  gd_confirm_disconnect: 'Google Drive 연결을 끊을까요? Google 쪽 권한도 지웁니다. 가져온 파일은 그대로 있습니다.',
  gd_disconnected: 'Google Drive 연결을 끊었습니다.', gd_now_connected: 'Google Drive를 연결했습니다. 가져올 파일을 고르세요.', gd_pick: '파일 고르기',
  gd_back_denied: 'Google에서 거절해서 연결하지 않았습니다.', gd_back_failed: 'Google Drive 연결에 실패했습니다. 다시 해 보세요.',
  gd_back_expired: '로그인이 너무 오래 걸렸거나 다른 브라우저에서 열렸습니다. 다시 해 보세요.', gd_back_no_scope: 'Google 화면에서 Drive 권한을 체크하지 않아 연결되지 않았습니다. 다시 하면서 체크하세요.',
  gd_picker_failed: 'Google Drive 선택 창을 열 수 없습니다(apis.google.com을 막는 확장 프로그램이 있나요?).',
  gd_importing_n: 'Google Drive에서 {n}개 가져오는 중…', gd_done: 'Google Drive 가져오기 완료', gd_into: '{folder}로',
  gd_st_queued: '대기', gd_st_importing: '가져오는 중…', gd_st_imported: '가져옴', gd_st_updated: '새 버전으로 바꿈', gd_st_unchanged: '바뀐 것 없음', gd_st_folder: '폴더',
  gd_summary: '새 파일 {imported} · 새 버전 {updated} · 그대로 {unchanged} · 실패 {failed}',
  mt_title: '드라이브로 연결', mt_help: '팀 폴더를 Finder나 Windows 탐색기에서 네트워크 드라이브처럼 엽니다. 웹에서 보고 바꿀 수 있는 것만 똑같이 보이고, 바꾸면 버전이 남고 지우면 휴지통으로 갑니다.',
  mt_address: '서버 주소', mt_user: '사용자 이름', mt_password: '비밀번호', mt_use_app_password: '앱 비밀번호(아래)',
  mt_mac: 'Mac (Finder)', mt_mac_steps: 'Finder에서 이동 → 서버에 연결(⌘K)을 고릅니다.|위의 서버 주소를 넣고 연결을 누릅니다.|“등록된 사용자”를 고르고 사용자 이름과 앱 비밀번호를 넣은 뒤 “키체인에 비밀번호 기억”을 체크합니다.',
  mt_win: 'Windows (파일 탐색기)', mt_win_steps: '파일 탐색기에서 “내 PC”를 오른쪽 클릭하고 “네트워크 드라이브 연결…”을 고릅니다.|드라이브 문자를 고르고 폴더에 위의 서버 주소를 붙여 넣은 뒤 “다른 자격 증명을 사용하여 연결”을 체크하고 마침을 누릅니다.|사용자 이름과 앱 비밀번호를 넣습니다.',
  mt_win_note: 'Windows는 WebClient 한도를 올리지 않으면 50MB가 넘는 파일을 드라이브로 복사하지 못합니다. 큰 파일은 웹에서 올리세요.',
  mt_notes: '이 서버에 보관한 팀 폴더만 보입니다(NAS에 있는 폴더는 드라이브에 나오지 않습니다). Mac이나 Office가 스스로 만드는 파일(.DS_Store, ._ 파일, ~$ 잠금 파일)은 저장하지 않습니다.',
  mt_not_https: '이 주소는 https가 아닙니다. 드라이브는 https로만 연결됩니다(이 컴퓨터 자신에서는 예외).',
  mt_off: '이 서버에서는 드라이브 연결을 쓸 수 없습니다(파일을 서버에 보관하는 방식에서만 됩니다).',
  mt_app_passwords: '앱 비밀번호', mt_app_help: '컴퓨터마다 하나씩 만드세요. 드라이브 연결에만, 나에게만 쓰이고 언제든 취소할 수 있습니다. 에이전트는 이것을 쓰지 않습니다(토큰으로 연결).',
  mt_new: '새 앱 비밀번호', mt_name: '어느 컴퓨터', mt_name_ph: '예: 회사 맥북', mt_confirm_pw: '내 비밀번호(본인 확인)',
  mt_create: '만들기', mt_shown_once: '지금 복사하세요. 한 번만 보여 줍니다.', mt_none: '아직 앱 비밀번호가 없습니다.', mt_revoke: '취소',
  mt_last_used: '마지막 사용 {date}', mt_never_used: '쓴 적 없음', mt_created: '{date}에 만듦', mt_confirm_revoke: '“{name}”을(를) 취소할까요? 그 컴퓨터의 드라이브 연결이 끊깁니다.',
}

export type DriveKey = keyof typeof en
export function dt(key: DriveKey, params?: Record<string, string | number>): string {
  const s = (getLocale() === 'ko' ? ko : en)[key] ?? en[key]
  return params ? s.replace(/\{(\w+)\}/g, (all, k: string) => (params[k] !== undefined ? String(params[k]) : all)) : s
}
