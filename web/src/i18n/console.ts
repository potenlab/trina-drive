// Screen text: links and words about the Trina Cloud console shown inside the drive (workstream C1).
// Merged by index.ts. Every key here is new (not in core.ts or another feature file); Korean must have every English
// key (TypeScript checks it). Plain data: no imports, no DOM.
export const en = {
  console_back: 'Back to console',
  console_back_help: 'Members, billing and your other teams',
  console_all_teams: 'All teams (Trina Cloud console)',
  console_members_note: 'Invite and remove people in the Trina Cloud console; groups are kept here.',
  console_managed: 'Managed in the Trina Cloud console',
  console_open: 'Open the console',
  console_invite_title: 'Invite to the team',
  console_invite_help: 'Trina Cloud mails the invitation. People join as members; admins are made in the console.',
  console_invite_send: 'Send invitation',
  console_invite_sent: 'Invitation sent to {email}.',
} satisfies Record<string, string>

export const ko: Record<keyof typeof en, string> = {
  console_back: '콘솔로 돌아가기',
  console_back_help: '멤버, 결제, 다른 팀',
  console_all_teams: '모든 팀(Trina Cloud 콘솔)',
  console_members_note: '사람 초대·제거는 Trina Cloud 콘솔에서 합니다. 그룹은 여기서 관리합니다.',
  console_managed: 'Trina Cloud 콘솔에서 관리',
  console_open: '콘솔 열기',
  console_invite_title: '팀에 초대',
  console_invite_help: 'Trina Cloud가 초대 메일을 보냅니다. 멤버로 들어오며, 관리자 지정은 콘솔에서 합니다.',
  console_invite_send: '초대 보내기',
  console_invite_sent: '{email}로 초대를 보냈습니다.',
}
