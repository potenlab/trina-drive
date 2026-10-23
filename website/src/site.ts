// Links and facts used across the site. Change them here, not in the pages.

export const SITE_URL = 'https://drive.trina.app'
export const CONTACT_EMAIL = 'contact@trina.app'

export const LINKS = {
  // The repository is public (source on GitHub; the LICENSE file is not published yet — don't claim an OSI license).
  github: 'https://github.com/potenlab/trina-drive',
  docs: 'https://github.com/potenlab/trina-drive#readme',
  securityModel: 'https://github.com/potenlab/trina-drive/blob/main/docs/SECURITY-MODEL.md',
  installGuide: 'https://github.com/potenlab/trina-drive/blob/main/docs/INSTALL.md',
  // TODO(launch): swap for a scheduling link (e.g. Cal.com) when there is one.
  bookCall: (lang: Lang) =>
    `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(lang === 'ko' ? 'Trina Drive 설치 상담 예약' : 'Trina Drive setup call')}`,
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
