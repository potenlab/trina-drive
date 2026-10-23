// Links and facts used across the site. Change them here, not in the pages.

export const SITE_URL = 'https://drive.trina.app'
export const CONTACT_EMAIL = 'contact@trina.app'

// Trina Cloud (the hosted product) is in early access while team provisioning is being built. While this is false,
// every "start" button (hero, nav, final call to action, the Cloud Team/Business price buttons) asks for early access
// by email instead of opening the Paddle checkout. Set it to true once a paid checkout creates a working team space:
// then those buttons open the Paddle checkout for Cloud Team (14-day trial) / Business as before.
export const CLOUD_LIVE: boolean = false

export const LINKS = {
  // The repository is public and the whole of it is licensed under Apache-2.0 (LICENSE at the repo root).
  github: 'https://github.com/potenlab/trina-drive',
  docs: 'https://github.com/potenlab/trina-drive#readme',
  securityModel: 'https://github.com/potenlab/trina-drive/blob/main/docs/SECURITY-MODEL.md',
  installGuide: 'https://github.com/potenlab/trina-drive/blob/main/docs/INSTALL.md',
  // TODO(launch): swap for a scheduling link (e.g. Cal.com) when there is one.
  bookCall: (lang: Lang) =>
    `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(lang === 'ko' ? 'Trina Drive 데모 예약' : 'Trina Drive demo')}`,
  // TODO(launch): swap for a sign-up form when Trina Cloud opens.
  earlyAccess: (lang: Lang) => earlyAccessMailto(lang),
}

export function earlyAccessMailto(lang: Lang, plan?: string): string {
  const subject = lang === 'ko' ? 'Trina Cloud 얼리 액세스 신청' : 'Trina Cloud early access'
  const lines = lang === 'ko'
    ? [...(plan ? [`플랜: ${plan}`] : []), '회사 이름:', '인원(AI를 연결할 사람 수):', '지금 파일이 있는 곳 (NAS, Google Drive 등):']
    : [...(plan ? [`Plan: ${plan}`] : []), 'Company:', 'AI-connected people:', 'Where your files are today (NAS, Google Drive…):']
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n') + '\n')}`
}

export type Lang = 'en' | 'ko'

export const COMPANY = {
  en: {
    name: 'Trina Inc.',
    line: [
      'Trina Inc. (주식회사 트리나)',
      'CEO Daehyun Nam',
      'Business registration no. 414-81-10138',
      '27-8 Obong-ro, Sannae-myeon, Gyeongju-si, Gyeongsangbuk-do, Republic of Korea',
      'Customer service +82-70-8064-3349',
      CONTACT_EMAIL,
      'Mail-order business registration (통신판매업 신고): in progress',
    ],
  },
  ko: {
    name: '주식회사 트리나',
    line: [
      '상호 주식회사 트리나',
      '대표 남대현',
      '사업자등록번호 414-81-10138',
      '주소 경상북도 경주시 산내면 오봉로 27-8',
      '고객센터 070-8064-3349',
      CONTACT_EMAIL,
      '통신판매업신고 신고 진행 중',
    ],
  },
} as const
