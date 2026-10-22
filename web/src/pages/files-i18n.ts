// Screen text of the Files view, English and Korean (kept apart from i18n.ts; the language is the app's own choice).
// Korean must have every English key (TypeScript checks it).
import { getLocale } from '../i18n'

const en = {
  nav_files: 'Files', files_title: 'Files', home: 'All files', folders: 'Folders', show_folders: 'Folders', hide_folders: 'Hide folders',
  my_drafts: 'My drafts', my_drafts_n: 'My drafts ({n})', my_drafts_help: 'What your agents wrote. Opens the drafts page.',
  search_placeholder: 'Search names and text', search_in: 'Search in {folder}', search: 'Search', clear: 'Clear',
  results_for: 'Results for “{q}” in {folder}', results_none: 'Nothing found.', results_more: 'Showing the first {n}. Narrow the search to see the rest.',
  results_partial: 'The search stopped early (too many files, or text still being read). Try a smaller folder.', search_everywhere: 'Search everywhere',
  name_match: 'Name', in_folder: 'in {folder}', line_n: 'line {n}',
  view_list: 'List', view_grid: 'Grid', sort_by: 'Sort', sort_name: 'Name', sort_date: 'Modified', sort_size: 'Size', sort_asc: 'Ascending', sort_desc: 'Descending',
  col_name: 'Name', col_modified: 'Modified', col_size: 'Size',
  empty_root: 'No folders you can open yet. Ask your admin which folders are set up for you.',
  empty_folder: 'This folder is empty, or holds nothing you can open.',
  bare_folder: 'You see this folder only as the way to a folder inside it. Its own files are not open to you.',
  not_found: 'This is not there, or you cannot open it.', error: 'Could not load this. Try again.', retry: 'Retry',
  folder: 'Folder', file: 'File', size: 'Size', modified: 'Modified', location: 'Location', kind: 'Type',
  contains_text: 'Contains text', no_text: 'No text to show', view_text: 'View text', download: 'Download', open: 'Open', close: 'Close',
  text_title: 'Text of {name}', text_extracted: 'Text read out of the document (layout and pictures are not shown).', text_truncated: 'Only the first part is shown. Download the file for all of it.',
  text_empty: '(no text)', text_none: 'This file has no text to show.', text_failed: 'The text of this file could not be read.',
  who_title: 'Who can see', who_ai: 'AI reads', who_web: 'Opens here', who_nas: 'Opens on the NAS', who_owner: 'Personal folder of {name}',
  who_blocked_no_ai: '“No AI”: no agent reads this folder. People with access still open it here.',
  who_blocked_closed: 'Closed for now (quarantined or waiting for review).',
  who_nas_all: 'Everyone in the office', who_nas_unknown: 'Not known (the admin has not said)', who_none: 'Nobody',
  who_restricted: 'You cannot open this folder’s own files, so its readers are not shown.',
  who_help: 'AI reads = what this server lets agents read. NAS = what the admin wrote down about the NAS itself.',
  keyboard_help: 'Arrow keys move, Enter opens, Backspace goes up.', up: 'Up',
}

type Key = keyof typeof en

const ko: Record<Key, string> = {
  nav_files: '파일', files_title: '파일', home: '전체 파일', folders: '폴더', show_folders: '폴더', hide_folders: '폴더 닫기',
  my_drafts: '내 초안', my_drafts_n: '내 초안 ({n})', my_drafts_help: '에이전트가 쓴 초안입니다. 초안함으로 갑니다.',
  search_placeholder: '이름과 본문 검색', search_in: '{folder}에서 검색', search: '검색', clear: '지우기',
  results_for: '{folder}에서 “{q}” 검색 결과', results_none: '찾은 것이 없습니다.', results_more: '앞의 {n}개만 보입니다. 검색 범위를 좁혀 보세요.',
  results_partial: '검색이 일찍 멈췄습니다(파일이 너무 많거나 아직 본문을 읽는 중). 더 작은 폴더에서 해 보세요.', search_everywhere: '전체에서 검색',
  name_match: '이름', in_folder: '{folder} 안', line_n: '{n}번째 줄',
  view_list: '목록', view_grid: '격자', sort_by: '정렬', sort_name: '이름', sort_date: '수정한 날', sort_size: '크기', sort_asc: '오름차순', sort_desc: '내림차순',
  col_name: '이름', col_modified: '수정한 날', col_size: '크기',
  empty_root: '열 수 있는 폴더가 아직 없습니다. 어떤 폴더가 열려 있는지 관리자에게 물어보세요.',
  empty_folder: '빈 폴더이거나, 열 수 있는 것이 없습니다.',
  bare_folder: '이 폴더는 안쪽 폴더로 가는 길로만 보입니다. 이 폴더의 파일은 열 수 없습니다.',
  not_found: '없거나 열 수 없습니다.', error: '불러오지 못했습니다. 다시 해 보세요.', retry: '다시',
  folder: '폴더', file: '파일', size: '크기', modified: '수정한 날', location: '위치', kind: '종류',
  contains_text: '본문 있음', no_text: '보여 줄 본문 없음', view_text: '본문 보기', download: '내려받기', open: '열기', close: '닫기',
  text_title: '{name} 본문', text_extracted: '문서에서 읽어 낸 글자입니다(서식과 그림은 빠집니다).', text_truncated: '앞부분만 보입니다. 전체는 내려받아 보세요.',
  text_empty: '(글자 없음)', text_none: '이 파일은 보여 줄 본문이 없습니다.', text_failed: '이 파일의 본문을 읽지 못했습니다.',
  who_title: '누가 볼 수 있나', who_ai: 'AI가 읽음', who_web: '여기서 엶', who_nas: 'NAS에서 엶', who_owner: '{name}의 개인 폴더',
  who_blocked_no_ai: '“AI 연결 금지”: 어떤 에이전트도 이 폴더를 읽지 않습니다. 권한이 있는 사람은 여기서 엽니다.',
  who_blocked_closed: '지금은 닫혀 있습니다(격리 또는 확인 대기).',
  who_nas_all: '사무실 전원', who_nas_unknown: '모름(관리자가 적지 않음)', who_none: '없음',
  who_restricted: '이 폴더의 파일은 열 수 없어서 독자를 보여 주지 않습니다.',
  who_help: 'AI가 읽음 = 이 서버가 에이전트에게 허락한 것. NAS = 관리자가 NAS 권한에 대해 적어 둔 것.',
  keyboard_help: '화살표로 움직이고, Enter로 열고, Backspace로 위로 갑니다.', up: '위로',
}

export type FilesKey = Key
export function ft(key: Key, params?: Record<string, string | number>): string {
  const s = (getLocale() === 'ko' ? ko : en)[key] ?? en[key]
  return params ? s.replace(/\{(\w+)\}/g, (all, k: string) => (params[k] !== undefined ? String(params[k]) : all)) : s
}
