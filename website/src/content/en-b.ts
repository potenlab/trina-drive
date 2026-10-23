// Variant B (/b): the same product for non-developer teams of 5 to 20 who use the Claude app, ChatGPT or the Codex
// app. Shared facts (pricing, the security promise, legal, terminal demo) come from en.ts unchanged; everything a
// non-developer reads first is rewritten in plain language here.
//
// Accuracy rules (same as en.ts): no "real bash"; AI can't change originals *through Trina Drive*; open source =
// "release coming soon"; never say Drive connectors can't read files; no fake logos, testimonials or YC claims; USD.
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
    sub: 'Ask Claude or ChatGPT about anything in your company’s files — last quarter’s numbers, past proposals, every contract — and get answers from the real documents. No uploading, no setting up a knowledge base. Each person’s AI only sees what they’re allowed to.',
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
  // Use cases by role. `before` is the pain in the person's own words.
  useCases: {
    eyebrow: 'What your team can do',
    title: 'Questions your team asks every week — answered from your own files.',
    sub: 'The jobs small teams ask AI for most — find it, draft it, summarize it — done with your own files. Everyone asks in their own AI app, and every answer names the files it came from.',
    all: 'All',
    roles: ['Founder', 'Ops & Finance', 'Sales', 'Projects', 'HR & People'],
    askLabel: 'Ask',
    getLabel: 'You get',
    beforeLabel: 'Before',
    items: [
      {
        role: 'Founder',
        prompt: 'Summarize Q3’s close for the partners: revenue, margin and cash against budget, the biggest variances, and what to ask our accountant.',
        get: 'A one-page table with a short explanation, every number traced to the spreadsheet it came from.',
        before: 'The bookkeeper sends five spreadsheets, and turning them into “how did we actually do?” takes an evening.',
      },
      {
        role: 'Sales',
        prompt: 'Draft a proposal for Lumen Coffee — brand refresh and a new website, about $60k, 12 weeks — modeled on our last three retail proposals and our rate card.',
        get: 'A draft in your house style with a pricing table, saved for a teammate to review before it goes out.',
        before: 'Every proposal starts with digging through old ones, copy-pasting sections and fixing prices by hand.',
      },
      {
        role: 'Projects',
        prompt: 'I have a call with Oakline tomorrow. What’s in our signed scope, what have we promised since, and what’s still open?',
        get: 'A one-page brief — scope, promises, open items, risks — each line pointing to the contract or meeting note.',
        before: 'Rereading the contract and three months of meeting notes before every client call.',
      },
      {
        role: 'Ops & Finance',
        prompt: 'Across all active client contracts, which ones let us show the work in our portfolio, and what’s the termination notice?',
        get: 'A table of clients, clauses and notice periods, with the contract each came from.',
        before: 'Opening thirty PDFs one by one whenever a client asks about rights or notice periods.',
      },
      {
        role: 'HR & People',
        prompt: 'I’m working from Lisbon for two weeks in December. What do I need to do, and can I expense a coworking space?',
        get: 'A short answer quoted from the handbook and the expense policy, with section numbers.',
        before: 'The office manager answers the same leave and expense questions every week.',
      },
      {
        role: 'Projects',
        prompt: 'Go through this week’s Lumen meeting notes: action items by owner and due date, then a recap email for the client.',
        get: 'An action table and a client-ready email draft, with internal comments left out.',
        before: 'Notes sit in five documents, action items get lost, and the recap goes out a day late.',
      },
      {
        role: 'Ops & Finance',
        prompt: 'Compare the three print quotes for the packaging run: unit price, minimum order, lead time and payment terms.',
        get: 'One comparison table, plus what each quote leaves out.',
        before: 'Quotes arrive as PDFs in three formats, and someone rebuilds the comparison by hand.',
      },
      {
        role: 'Sales',
        prompt: 'Answer the supplier questionnaire in the Acme folder from our past bids and certifications. Mark anything you can’t find.',
        get: 'A filled-in draft with sources, and a short list of gaps for you to answer.',
        before: 'Every tender asks the same sixty questions, answered from scratch.',
      },
    ],
  },
  // Pain in people's own words: public posts, quoted verbatim and linked (research_notes/비개발 팀 AI 문서 활용 고충).
  // Not customers and not testimonials: these are about AI tools in general, not about Trina Drive.
  pains: {
    title: 'Sound familiar?',
    sub: 'What people say about using AI with their company’s files today.',
    items: [
      {
        quote: 'A lot of my AI chats are about copy pasting bits of information into a chat just to create enough of a context',
        where: 'Hacker News',
        href: 'https://news.ycombinator.com/item?id=45692241',
        answer: 'Nothing to paste or upload: the AI reads your folders directly.',
      },
      {
        quote: 'If ChatGPT continues using an older uploaded version, it can give outdated guidance while appearing confident.',
        where: 'OpenAI Developer Community',
        href: 'https://community.openai.com/t/chatgpt-projects-live-updating-project-source-documents/1383881',
        answer: 'Always the current file, from where it lives.',
      },
      {
        quote: 'There’s ZERO way our legal team will let us connect ChatGPT to Google Drive for example.',
        where: 'Hacker News',
        href: 'https://news.ycombinator.com/item?id=45692241',
        answer: 'You choose, folder by folder, whose AI may read what.',
      },
    ],
  },
  works: {
    eyebrow: 'Works where you already work',
    title: 'Keep your AI app. Keep your folders.',
    sub: 'Nobody learns a new tool and nothing moves. Trina Drive sits between the AI apps your team already pays for and the folders your files already live in.',
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
      { icon: 'nas', name: 'A NAS', note: 'Synology, QNAP and other shared drives on your network' },
      { icon: 'mac', name: 'A folder on the office Mac', note: 'Including scans and exports saved there' },
      { icon: 'folder', name: 'A synced cloud folder', note: 'A Google Drive or Dropbox folder synced to that Mac' },
    ],
    filesNote: 'Files stay where they are. People keep opening them in Finder, Explorer and Office as before.',
    center: 'Trina Drive',
    centerNote: 'on a Mac mini in your office',
  },
  // Enterprise way vs small-team way, in plain language. Same shape as en.kb.
  kb: {
    eyebrow: 'No knowledge-base project',
    title: 'Enterprises build ontologies. Small teams have folders.',
    sub: 'Big companies spend months turning their documents into something an AI can use. Your team already has that: your folders.',
    cols: [
      {
        name: 'The enterprise way',
        tag: 'Knowledge graphs · data pipelines · consultants',
        points: [
          'Months of mapping your documents before anyone can ask a question',
          'Consultants to design it, a team to keep it up to date',
          'Every new file has to be processed before the AI can find it',
          'Answers stitched together from fragments — hard to check',
        ],
        foot: 'Built for companies with a data team and a budget',
        us: false,
      },
      {
        name: 'The small-team way',
        tag: 'Trina Drive',
        points: [
          'Point it at the folders you already have',
          'Your AI looks through the files themselves, the way a colleague would',
          'Every answer names the files it came from',
          'Running in an afternoon — we set it up, or self-host it free',
        ],
        foot: 'For teams of 5 to 20',
        us: true,
      },
    ],
  },
  // vs. a cloud-drive connector. Don't claim connectors can't read files: they read one at a time.
  gdrive: {
    eyebrow: 'vs. a Google Drive connector',
    title: 'Ask across all your files, not one at a time.',
    sub: 'The Drive connectors in Claude and ChatGPT find a file and read it — fine for one document. Questions like “which contracts…” need every file checked. Trina Drive lets your AI search inside all of them at once.',
    left: {
      name: 'Drive connector',
      points: ['Reads files one at a time', 'Can’t check every file for a phrase in one go', 'Your files must live in Google Drive first'],
    },
    right: {
      name: 'Trina Drive',
      points: ['Searches inside every shared folder at once', 'Reads PDFs, Word, Excel and PowerPoint', 'Answers name the files they came from', 'Works with the NAS and folders you already have'],
    },
    demo: [] as string[],
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
    sub: 'One AI knowledge base for the whole team doesn’t mean everyone sees everything.',
    items: [
      {
        icon: 'filter',
        label: 'Access',
        title: 'Each person’s AI sees only what they may.',
        body: 'Choose, folder by folder, whose AI may read it. Sam in Finance can ask about the numbers; for everyone else’s AI, the finance folder simply isn’t there.',
      },
      {
        icon: 'draft',
        label: 'Originals',
        title: 'Through Trina Drive, AI writes drafts, not originals.',
        body: 'AI can’t change or delete your files through Trina Drive. It saves drafts that remember which folders they came from, and a teammate moves them where they belong.',
      },
      {
        icon: 'log',
        label: 'Record',
        title: 'Every file an AI opens is on the record.',
        body: 'Who asked, from which app, which file. Owners see it in one log, and the log can’t be quietly rewritten.',
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
  // Same promise (word for word) as en.security; protect/limits rewritten in plain language.
  security: {
    ...en.security,
    protect: [
      'Each person’s AI can read only the folders that person is allowed to — and you can narrow it further.',
      'Folders an AI isn’t allowed to see don’t show up at all, not even their names.',
      'Through Trina Drive nobody can change or delete your original files — not even admins.',
      'A newly added folder is hidden from every AI until you choose who may use it.',
      'Connections expire, can be cut off instantly, and a new device triggers an alert.',
      'Every file an AI opens is recorded in a log that can’t be quietly edited.',
    ],
    limits: [
      'What an AI reads goes to the AI company you use. Mark folders that must never leave as “No AI”.',
      'The protection covers access through Trina Drive. Someone opening the NAS directly from a laptop goes around it.',
      'It can’t make an AI immune to instructions hidden in documents (prompt injection). It limits what the AI can reach and records what it read.',
      'Copies an AI keeps in its own memory, or that someone saves to their laptop, aren’t tracked.',
      'It doesn’t copy your NAS permissions automatically: you choose, folder by folder, whose AI may read it.',
    ],
  },
  pricing: {
    ...en.pricing,
    title: 'We set it up and run it. Or self-host it free.',
    sub: 'Built for teams of 5 to 20. On a managed plan we install and run Trina Drive on your office Mac mini — updates, backups and monitoring included. Priced on AI-connected people; everyone who only opens files is free. Every security feature is also free to self-host.',
  },
  setup: {
    eyebrow: 'Set up for you',
    title: 'One call, and your team is asking questions.',
    sub: 'We set it up on a Mac mini in your office, connect your folders, and get your team’s AI apps connected — in one call. No IT team needed.',
    steps: [
      {
        title: 'Book a call',
        body: 'We go through your folders with you and decide together who should see what.',
      },
      {
        title: 'We set it up in your office',
        body: 'Trina Drive runs on a Mac mini on your own network, and we connect the folders you chose. We install it remotely, or on site in Korea.',
      },
      {
        title: 'Everyone connects their AI app',
        body: 'Each person signs in once from their AI app. We walk the team through it on the call, then keep it running: updates, backups and monitoring.',
      },
    ],
    selfTitle: 'Have someone technical?',
    selfBody: 'The same software is free to self-host, with every security feature. It needs someone comfortable with a terminal.',
    selfLink: 'Install guide',
  },
  devs: {
    eyebrow: 'For developers',
    title: 'Also in Claude Code, Codex CLI and Cursor.',
    sub: 'Developers connect with one command. Their agents use the commands they already know — ls, grep, cat — over only the folders their person may read, including the text inside PDF and Office files.',
    points: [
      'A personal token per person, kept in the Keychain, 7 days by default',
      'Narrow any token to one folder, read-only, or a shorter time',
      'Writes go to the draft box; every call lands in the audit log',
    ],
    install: 'tdrive mcp add claude',
    link: 'Developer docs',
  },
  faq: {
    ...en.faq,
    items: [
      {
        q: 'Do I need to know anything technical?',
        a: 'No. On a managed plan we set everything up on a Mac mini in your office, connect your folders and walk your team through connecting their AI apps. After that, people just ask questions in Claude, ChatGPT or Codex as they do today. Self-hosting is free, but it needs someone comfortable with a terminal.',
      },
      {
        q: 'Which AI apps work?',
        a: 'The Codex app and the developer tools (Claude Code, Codex CLI, Cursor) work today. Connections for Claude (claude.ai and the desktop and mobile apps) and ChatGPT are built and rolling out in v0.2. In ChatGPT, Trina Drive is added as a custom connector, which needs developer mode; which ChatGPT plans allow it is up to OpenAI.',
      },
      {
        q: 'Do I have to move our files?',
        a: 'No. Trina Drive reads the folders where your files already are — a NAS, a folder on the office Mac, or a Google Drive or Dropbox folder synced to that Mac. There is no direct connection to Google Drive itself. Nothing is copied to us, and people keep using Finder, Explorer and Office.',
      },
      {
        q: 'Is our data used to train AI?',
        a: 'Trina Drive doesn’t train any AI model and doesn’t send your files to us. When someone’s AI reads a file, that text goes to the AI company they use (Anthropic, OpenAI and others), under the terms of your plan with that company — whether it may be used for training is set there, not by us. Folders that must never reach an AI company can be marked “No AI”.',
      },
      {
        q: 'How is this different from uploading files to ChatGPT or Claude?',
        a: 'Uploads are copies: each person uploads their own, and they go out of date the moment someone edits the original. With Trina Drive the AI reads the current files where they live, and only the folders that person is allowed to see.',
      },
      {
        q: 'Can the AI change or delete our files?',
        a: 'Not through Trina Drive. Originals are read-only there, for everyone including admins. The AI saves drafts (text or spreadsheet files) in a separate draft box, and a person decides where they go.',
      },
      {
        q: 'Why not just use a Google Drive connector?',
        a: 'If your files already live in Google Drive and your questions are about one document at a time, that is a sensible choice. A connector reads one file at a time; it can’t check every file for a phrase in one go. Trina Drive searches inside every registered folder at once, on the NAS or Mac you already have.',
      },
      {
        q: 'How is this different from a RAG or knowledge-graph product?',
        a: 'There is nothing to model or pre-process. The AI searches your folders and reads the files themselves, so when a file changes, the next question sees the change. Text inside PDF and Office files is pulled out the first time it’s needed and kept for next time.',
      },
      {
        q: 'Someone left, or a laptop was lost. Now what?',
        a: 'Cut off their connection in the web app; the very next request fails. Connections also expire on their own, and the owner is alerted when a new device starts using one.',
      },
      en.faq.items[9]!,
      en.faq.items[10]!,
    ],
  },
  cta: {
    ...en.cta,
    title: 'Give your team an AI knowledge base without building one.',
    sub: 'Book a call. We set it up on a Mac mini in your office and connect your team’s AI apps.',
    primary: 'Book a setup call',
    secondary: 'See pricing',
  },
}

export default enB
export type CopyB = typeof enB
