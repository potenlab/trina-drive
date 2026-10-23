// Variant B (/b): the same product for non-developer teams of 5 to 20 who use the Claude app, ChatGPT or the Codex
// app. Shared facts (pricing, the security promise, legal, terminal demo) come from en.ts unchanged; everything a
// non-developer reads first is rewritten in plain language here.
//
// Accuracy rules (same as en.ts): no "real bash"; AI can't change originals *through Trina Drive*; open source =
// "Apache-2.0, source on GitHub"; never say Drive connectors can't read files; no fake logos, testimonials or YC claims; USD.
// Client logos: only official files the brand allows (public/logos/SOURCES.md); Claude stays text (needs approval).
// claude.ai / Claude apps and ChatGPT connect over OAuth in v0.2 ("rolling out"); Codex app, Codex CLI, Claude Code
// and Cursor connect today. Drafts are Markdown or CSV. PDFs are read by their text layer (no OCR before v0.3).
// Demo people, companies, files and numbers are fictional.
import en from './en'

export interface ChatTurn {
  /** Fictional person asking, and the team they are in (drives the "what this AI can see" panel). */
  who: string
  team: string
  tab: string
  q: string
  /** Folders this person's AI may read (keys of chat.folders). */
  sees: string[]
  /** Files the AI opens for this answer: [folder, file]. */
  reads: [string, string][]
  status: string
  lead: string
  table?: { cols: string[]; rows: string[][] }
  list?: { title: string; detail: string; ref: string }[]
  outline?: string[]
  tail?: string
  saved?: { label: string; path: string; note: string }
  sources: string[]
}

const enB = {
  ...en,
  meta: {
    ...en.meta,
    title: 'Trina Drive — ask Claude or ChatGPT about your company’s files',
    description:
      'Your company folders, as your team’s AI knowledge base. Ask Claude or ChatGPT about last quarter’s numbers, past proposals or any contract and get answers from the real documents. No uploading, no knowledge-base project, and each person’s AI only sees what they’re allowed to. Set up for you, for teams of 5 to 20.',
  },
  hero: {
    ...en.hero,
    pill: 'Claude and ChatGPT connections rolling out now',
    title: 'Your company folders,',
    titleAccent: 'as your team’s AI knowledge base.',
    sub: 'Ask Claude or ChatGPT about your company’s files. No uploads. Everyone sees only what they should.',
    primary: 'See what your team can ask',
    secondary: 'Book a setup call',
  },
  proof: [
    { icon: 'user', text: 'Built for teams of 5 to 20' },
    { icon: 'folder', text: 'Always the current file — nothing to upload' },
    { icon: 'sparkle', text: 'We set it up for you' },
  ],
  // Hero visual: a neutral AI chat window (no vendor branding) beside the company folders it can read.
  chat: {
    label: 'Demo: four people ask their AI app about company files and get answers with the files they came from',
    app: 'Your AI app',
    connected: 'connected to Trina Drive',
    signedIn: 'Signed in as',
    placeholder: 'Ask about your company’s files…',
    send: 'Send',
    sourcesLabel: 'Sources',
    pick: 'Pick an example',
    transcriptTitle: 'Demo conversations',
    foldersTitle: 'Company folders',
    foldersSub: 'What this person’s AI can see',
    folders: {
      finance: { name: 'Finance', access: 'Finance team' },
      sales: { name: 'Sales', access: 'Everyone' },
      contracts: { name: 'Contracts', access: 'Ops & leads' },
      hr: { name: 'HR', access: 'Everyone' },
      payroll: { name: 'Payroll', access: 'No AI' },
    } as Record<string, { name: string; access: string }>,
    hidden: 'Hidden from this AI',
    noAi: 'No AI',
    reading: 'Reading',
    filesFoot: 'Files stay on your office network',
    turns: [
      {
        who: 'Sam',
        team: 'Finance',
        tab: 'Quarter close',
        q: 'Summarize last quarter’s close for the leadership meeting.',
        sees: ['finance', 'sales', 'contracts', 'hr'],
        reads: [['finance', '2026-Q3-close.xlsx'], ['finance', 'board-memo-Q3.pdf']],
        status: 'Searched company files · read 2',
        lead: 'Q3 against Q2, ready for the leadership meeting:',
        table: {
          cols: ['', 'Q3', 'Q2', 'Change'],
          rows: [
            ['Revenue', '$1.42M', '$1.31M', '+8.4%'],
            ['Costs', '$1.06M', '$1.02M', '+3.9%'],
            ['Operating margin', '25.4%', '22.1%', '+3.3 pts'],
          ],
        },
        tail: 'Main driver: two new retainer clients from August (board memo, section 2).',
        sources: ['finance/2026-Q3-close.xlsx', 'finance/board-memo-Q3.pdf'],
      },
      {
        who: 'Mina',
        team: 'Sales',
        tab: 'Proposal draft',
        q: 'Draft a proposal for Acme in our usual style, based on our last three proposals.',
        sees: ['sales', 'contracts', 'hr'],
        reads: [['sales', 'proposals/northwind-2026-05.docx'], ['sales', 'proposals/globex-2026-07.docx'], ['sales', 'proposals/initech-2026-09.docx']],
        status: 'Searched company files · read 3',
        lead: 'Here’s a draft in the structure of your last three proposals:',
        outline: [
          'Summary — Acme’s goal in one paragraph',
          'Scope — three phases, as in the Globex proposal',
          'Timeline — 8 weeks, with a review at week 4',
          'Pricing — fixed fee plus monthly support, your usual split',
          'Why us — the Northwind and Globex results',
        ],
        saved: {
          label: 'Saved as a draft',
          path: 'drafts/acme-proposal.md',
          note: 'A teammate reviews it before it goes to the shared folder.',
        },
        sources: ['sales/proposals/northwind-2026-05.docx', 'sales/proposals/globex-2026-07.docx', 'sales/proposals/initech-2026-09.docx'],
      },
      {
        who: 'Jordan',
        team: 'Operations',
        tab: 'Contracts',
        q: 'Which client contracts have a termination fee above $10k?',
        sees: ['finance', 'sales', 'contracts', 'hr'],
        reads: [['contracts', 'acme-supply-2026.pdf'], ['contracts', 'northwind-msa.docx'], ['contracts', 'globex-services.pdf']],
        status: 'Searched 41 contracts · read 3',
        lead: 'Three of 41 client contracts have a termination fee above $10,000:',
        list: [
          { title: 'Acme Supply', detail: '$36,000 — three months of fees', ref: 'clause 12.3' },
          { title: 'Northwind MSA', detail: '10% of the remaining value, about $18,500', ref: 'clause 9.2' },
          { title: 'Globex Services', detail: '$12,000 flat', ref: 'clause 14.1' },
        ],
        tail: 'Two more have smaller fees; the rest have none.',
        sources: ['contracts/acme-supply-2026.pdf', 'contracts/northwind-msa.docx', 'contracts/globex-services.pdf'],
      },
      {
        who: 'Alex',
        team: 'Design',
        tab: 'HR policy',
        q: 'What’s our policy on remote work equipment?',
        sees: ['sales', 'hr'],
        reads: [['hr', 'handbook.pdf']],
        status: 'Searched company files · read 1',
        lead: 'From the employee handbook (section 4.3, “Remote work equipment”):',
        outline: [
          'Up to $1,500 every two years for a laptop stand, monitor, keyboard and chair',
          'Order through Operations, or expense it with receipts',
          'Equipment stays company property; return it if you leave',
        ],
        sources: ['hr/handbook.pdf'],
      },
    ] as ChatTurn[],
  },
  // Use cases by role: the question as asked, and what comes back.
  useCases: {
    eyebrow: 'What your team can do',
    title: 'Questions your team asks every week.',
    sub: 'Ask in your own AI app. Every answer names its files.',
    all: 'All',
    roles: ['Founder', 'Ops & Finance', 'Sales', 'Projects', 'HR & People'],
    askLabel: 'Ask',
    getLabel: 'You get',
    items: [
      {
        role: 'Founder',
        prompt: 'Summarize Q3’s close: revenue, margin and cash against budget.',
        get: 'A one-page table, each number traced to its file.',
      },
      {
        role: 'Sales',
        prompt: 'Draft a Lumen Coffee proposal like our last three.',
        get: 'A draft in your house style, saved for review.',
      },
      {
        role: 'Projects',
        prompt: 'Oakline call tomorrow: what’s in scope, and what’s still open?',
        get: 'A one-page brief, each line with its source.',
      },
      {
        role: 'Ops & Finance',
        prompt: 'Which client contracts let us show the work publicly?',
        get: 'Clients and clauses in one table.',
      },
      {
        role: 'HR & People',
        prompt: 'Working from Lisbon for two weeks. Can I expense coworking?',
        get: 'A short answer quoted from the handbook.',
      },
      {
        role: 'Ops & Finance',
        prompt: 'Compare the three print quotes: price, minimum, lead time.',
        get: 'One table, plus what each quote leaves out.',
      },
    ],
  },
  // Pain in people's own words: public posts, quoted verbatim and linked (research_notes/비개발 팀 AI 문서 활용 고충).
  // Not customers and not testimonials: these are about AI tools in general, not about Trina Drive.
  pains: {
    title: 'Sound familiar?',
    sub: '',
    items: [
      {
        quote: 'A lot of my AI chats are about copy pasting bits of information into a chat just to create enough of a context',
        where: 'Hacker News',
        href: 'https://news.ycombinator.com/item?id=45692241',
        answer: 'Nothing to paste. The AI reads your folders.',
      },
      {
        quote: 'If ChatGPT continues using an older uploaded version, it can give outdated guidance while appearing confident.',
        where: 'OpenAI Developer Community',
        href: 'https://community.openai.com/t/chatgpt-projects-live-updating-project-source-documents/1383881',
        answer: 'Always the current file.',
      },
      {
        quote: 'There’s ZERO way our legal team will let us connect ChatGPT to Google Drive for example.',
        where: 'Hacker News',
        href: 'https://news.ycombinator.com/item?id=45692241',
        answer: 'You choose whose AI reads which folder.',
      },
    ],
  },
  works: {
    eyebrow: 'Works where you already work',
    title: 'Keep your AI app. Keep your folders.',
    sub: 'Nothing moves, and nobody learns a new tool.',
    appsTitle: 'The AI apps your team uses',
    apps: [
      { name: 'Claude app & claude.ai', note: 'desktop, web and mobile', status: 'soon' },
      { name: 'ChatGPT', note: 'via a custom connector', status: 'soon' },
      { name: 'Codex app', note: '', status: 'today' },
    ],
    devTitle: 'For developers on your team',
    devApps: ['Claude Code', 'Codex CLI', 'Cursor'],
    today: 'available today',
    soon: 'rolling out (v0.2)',
    filesTitle: 'Where your files already live',
    files: [
      { icon: 'nas', name: 'A NAS', note: 'Synology, QNAP and others' },
      { icon: 'mac', name: 'A folder on the office Mac', note: 'Scans and exports too' },
      { icon: 'folder', name: 'A synced cloud folder', note: 'Google Drive or Dropbox, synced' },
    ],
    filesNote: 'People keep using Finder, Explorer and Office.',
    center: 'Trina Drive',
    centerNote: 'on a Mac mini in your office',
  },
  // One compact comparison in plain language (same shape as en.compare). Never say Drive connectors can't read files.
  compare: {
    eyebrow: 'Why it’s different',
    title: 'No knowledge-base project. No one-file connector.',
    sub: 'Your AI searches inside every shared folder at once, where files already live.',
    cols: ['Knowledge-base project', 'Drive connector', 'Trina Drive'],
    rows: [
      { label: 'Getting started', cells: ['Months of mapping documents', 'Files in Google Drive first', 'Point at the folders you have'] },
      { label: '“Which contracts…?”', cells: ['Answers from fragments', 'Opens files one at a time', 'Searches inside all of them at once'] },
      { label: 'A file changes', cells: ['Processed again first', 'Read it again', 'Next question sees it'] },
    ],
    demoLabel: 'One question, every folder',
    demo: [] as string[],
    types: ['PDF', 'Word', 'Excel', 'PowerPoint'],
    search: {
      query: 'renewal date',
      count: '3 files across Contracts, Projects and Shared',
      hits: [
        { file: 'contracts/acme-supply-2026.pdf', line: 'Renewal date: 31 March 2027' },
        { file: 'projects/globex/statement-of-work.docx', line: '…the renewal date shall be agreed…' },
        { file: 'shared/vendors.xlsx', line: 'Northwind · renewal date · 1 Dec 2026' },
      ],
    },
  },
  // "Shared with the whole team, safely" — three plain cards with small UI illustrations (no terminals).
  safe: {
    eyebrow: 'Safe to share',
    title: 'Shared with the whole team, safely.',
    sub: 'One knowledge base doesn’t mean everyone sees everything.',
    items: [
      {
        icon: 'filter',
        label: 'Access',
        title: 'Each person’s AI sees only what they may.',
        body: '',
      },
      {
        icon: 'draft',
        label: 'Originals',
        title: 'Through Trina Drive, AI writes drafts, not originals.',
        body: '',
      },
      {
        icon: 'log',
        label: 'Record',
        title: 'Every file an AI opens is on the record.',
        body: '',
      },
    ],
    views: [
      { who: 'Sam', team: 'Finance', folders: ['Finance', 'Sales', 'Contracts', 'HR'] },
      { who: 'Alex', team: 'Design', folders: ['Sales', 'HR'] },
    ],
    viewLabel: '’s AI sees',
    draft: { path: 'drafts/', file: 'acme-proposal.md', sourcesLabel: 'Made from', sources: ['Sales', 'Contracts'], visible: 'Only people who can see both folders can open it', move: 'Move to Shared', moveNote: 'needs a person' },
    log: [
      { t: '09:14', who: 'Sam', via: 'Claude', file: 'finance/board-memo-Q3.pdf' },
      { t: '09:31', who: 'Mina', via: 'ChatGPT', file: 'sales/proposals/globex-2026-07.docx' },
      { t: '10:02', who: 'Jordan', via: 'Codex', file: 'contracts/northwind-msa.docx' },
    ],
    logNote: 'Checked against a copy kept off the server',
  },
  // Same promise (word for word) as en.security, which /security shows; the three limits in plain language.
  security: {
    ...en.security,
    limits: [
      'What AI reads goes to your AI company; use “No AI” folders.',
      'Covers access through Trina Drive only.',
      'Can’t stop instructions hidden in documents; it limits and records.',
    ],
  },
  pricing: {
    ...en.pricing,
    title: 'We set it up and run it. Or self-host it free.',
    sub: 'Priced on AI-connected people. File-only people are free.',
  },
  setup: {
    eyebrow: 'Set up for you',
    title: 'One call, and your team is asking.',
    sub: 'We set it up in your office. No IT team needed.',
    steps: [
      { title: 'Book a call', body: 'Decide together who should see what.' },
      { title: 'We set it up in your office', body: 'A Mac mini on your network. Remote, or on-site in Korea.' },
      { title: 'Everyone connects their AI app', body: 'One sign-in each. We keep it updated and backed up.' },
    ],
    selfTitle: 'Have someone technical?',
    selfBody: 'Self-host free, with every security feature.',
    selfLink: 'Install guide',
  },
  devs: {
    eyebrow: 'For developers',
    title: 'Also in Claude Code, Codex CLI and Cursor.',
    sub: 'One command. ls, grep and cat over only the folders they may read.',
    points: [
      'Personal token in the Keychain, 7 days by default',
      'Narrow to one folder, read-only, or less time',
    ],
    install: 'tdrive mcp add claude',
    link: 'Developer docs',
  },
  faq: {
    ...en.faq,
    items: [
      {
        q: 'Do I need to know anything technical?',
        a: 'No. We set it up and connect your team’s AI apps. Self-hosting is free but needs someone comfortable with a terminal.',
      },
      {
        q: 'Which AI apps work?',
        a: 'The Codex app, Claude Code, Codex CLI and Cursor today. Claude and ChatGPT connections are rolling out in v0.2; ChatGPT adds it as a custom connector in developer mode, on plans where OpenAI allows it.',
      },
      {
        q: 'Do I have to move our files?',
        a: 'No. It reads them where they are: a NAS, the office Mac, or a Google Drive or Dropbox folder synced to it. Nothing is copied to us.',
      },
      {
        q: 'Is our data used to train AI?',
        a: 'Trina Drive trains no model. Text an AI reads goes to your AI company, under your plan with them. Mark folders “No AI” to keep them out.',
      },
      {
        q: 'How is this different from uploading files?',
        a: 'Uploads are copies that go stale. Here the AI reads the current file, and only where that person may look.',
      },
      {
        q: 'Can the AI change or delete our files?',
        a: 'Not through Trina Drive: originals are read-only there, even for admins. The AI saves drafts, and a person decides where they go.',
      },
    ],
  },
  cta: {
    ...en.cta,
    title: 'An AI knowledge base, without building one.',
    sub: 'Book a call. We set it up and connect your team.',
    primary: 'Book a setup call',
    secondary: 'See pricing',
  },
}

export default enB
export type CopyB = typeof enB
