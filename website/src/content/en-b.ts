// Variant B (/b): the same product for non-developer teams of 5 to 20 who use the Claude app, ChatGPT or the Codex
// app. Same page structure as variant A (supabase.com-style: hero, product grid, Trina Cloud, open source, pricing,
// FAQ); B differs in the hero visual (an animated AI chat beside the company folders), the use-case gallery and a few
// plainer words. Everything else (pricing, the security promise, legal) comes from en.ts unchanged.
//
// Accuracy rules (same as en.ts): no "real bash"; AI can't change originals *through Trina Drive*; open source =
// "Apache-2.0, source on GitHub"; never say Drive connectors can't read files; no fake logos, testimonials or YC claims; USD.
// Client logos: only official files the brand allows (LOGO-SOURCES.md); Claude stays text (needs approval).
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
    title: 'Trina Drive — a team drive you can ask Claude or ChatGPT about',
    description:
      'Keep your team’s files in Trina Drive and ask Claude or ChatGPT about last quarter’s numbers, past proposals or any contract — answers come from the real documents, and each person’s AI only sees what they may. Hosted on Trina Cloud, or open source to self-host free.',
  },
  hero: {
    ...en.hero,
    sub: 'Keep your team’s files in one drive. Ask Claude or ChatGPT about them. Everyone sees only what they should.',
  },
  proof: [
    { icon: 'user', text: 'Built for teams of 5 to 20' },
    { icon: 'upload', text: 'Drag and drop, like Google Drive' },
    { icon: 'sparkle', text: 'Nothing to install' },
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
    filesFoot: 'Files in your team’s Trina Cloud',
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
  how: {
    ...en.how,
    title: 'Three steps.\nNo IT team needed.',
    steps: [
      { title: 'Create your team drive', body: 'Sign up and invite your team.' },
      { title: 'Add your files', body: 'Drag and drop, or import from Google Drive (beta). Choose who sees each folder.' },
      { title: 'Connect your AI app', body: 'One sign-in for Claude or ChatGPT (rolling out). The Codex app works today.' },
    ],
  },
  faq: {
    ...en.faq,
    items: [
      {
        q: 'Do I need to know anything technical?',
        a: 'No. Sign up, drop your files in, connect your AI app. Self-hosting is free but needs someone comfortable with a terminal.',
      },
      {
        q: 'Is there a free plan?',
        a: 'Yes: 1 GB and up to 3 people. Free drives pause after 7 days without activity; paid plans don’t.',
      },
      {
        q: 'Which AI apps work?',
        a: 'The Codex app, Claude Code, Codex CLI and Cursor today. Claude and ChatGPT connections are rolling out; ChatGPT adds it as a custom connector, on plans where OpenAI allows it.',
      },
      {
        q: 'Where are our files stored?',
        a: 'On Trina Cloud: your team’s own isolated space, hosted in the US (more regions later). Or on your own server, if you self-host.',
      },
      {
        q: 'Do you train AI on our files?',
        a: 'No. Text an AI reads goes to your AI company, under your plan with them. Mark folders “No AI” to keep them out.',
      },
      {
        q: 'Can the AI change or delete our files?',
        a: 'Not through Trina Drive. The AI saves drafts, and a person decides where they go.',
      },
      {
        q: 'Can we leave?',
        a: 'Anytime. Export everything, or run it yourself: the code is open source (Apache-2.0).',
      },
    ],
  },
}

export default enB
export type CopyB = typeof enB
