// Site copy (English only). Facts come from the plan (sections 0, 2.6, 3–5, 7, 8), the repo README, its security
// model and research/trina-drive/PRICING.md; positioning from the 2026-10-23 report and the owner's notes.
// Do not add features here that the product does not have. Demo names are fictional.

export type TermLine =
  | { k: 'comment'; text: string; who?: 'alex' | 'sam' }
  | { k: 'cmd'; who: 'alex' | 'sam'; text: string }
  | { k: 'out' | 'err' | 'ok' | 'muted'; text: string }

const en = {
  lang: 'en' as 'en' | 'ko',
  meta: {
    title: 'Trina Drive — your company folders, as your team’s AI knowledge base',
    description:
      'No ontology, no RAG pipeline, no uploads. Claude, Codex and Cursor search and read your company files directly — grep inside PDFs and Office files — and each person’s AI sees only what they’re allowed to. For teams of 5 to 20, on the NAS you already have.',
    ogImage: '/og.png',
    ogAlt: 'Trina Drive: your company folders, as your team’s AI knowledge base',
  },
  skip: 'Skip to content',
  nav: {
    docs: 'Docs',
    github: 'GitHub',
    pricing: 'Pricing',
    security: 'Security',
    faq: 'FAQ',
    book: 'Book a setup call',
    start: 'Get started',
    theme: 'Toggle dark mode',
    menu: 'Menu',
  },
  // The H1 is two parts so the second can carry the accent gradient. Either part can be swapped freely.
  hero: {
    pill: 'Open source · Apache-2.0',
    title: 'Your company folders,',
    titleAccent: 'as your team’s AI knowledge base.',
    sub: 'Your AI searches and reads your team’s files directly. No uploads, no RAG, scoped per person.',
    primary: 'See how it works',
    secondary: 'Book a setup call',
    github: 'View on GitHub',
    install: 'tdrive mcp add claude',
    copy: 'Copy',
    copied: 'Copied',
  },
  // Hero demo: first knowledge retrieval across PDF / Word / Excel, then the same search scoped per person, then drafts.
  terminal: {
    label: 'Demo: an agent searches company contracts, then two people get different answers to the same search',
    tabs: { alex: 'alex · member', sam: 'sam · finance' },
    replay: 'Replay',
    transcriptTitle: 'Demo transcript',
    lines: [
      { k: 'comment', who: 'alex', text: '# Alex asks Claude Code: “Which contracts have a termination fee?”' },
      { k: 'cmd', who: 'alex', text: 'grep -ri "termination fee" /contracts' },
      { k: 'out', text: '/contracts/acme_supply_2026.pdf: 12.3 Termination fee: three months of fees' },
      { k: 'out', text: '/contracts/northwind_msa.docx: a termination fee equal to 10% of the …' },
      { k: 'out', text: '/contracts/globex_renewals.xlsx: Termination fee | $4,000' },
      { k: 'muted', text: '(Claude reads the three files and answers — nothing uploaded, nothing indexed)' },
      { k: 'comment', who: 'alex', text: '# Alex is not in Finance' },
      { k: 'cmd', who: 'alex', text: 'grep -ri revenue /' },
      { k: 'muted', text: '(no matches — for Alex, /finance does not exist)' },
      { k: 'comment', who: 'sam', text: '# Sam’s Claude Code — Sam is in Finance' },
      { k: 'cmd', who: 'sam', text: 'grep -ri revenue /' },
      { k: 'out', text: '/finance/board_memo.pdf: Revenue target: $9.2M' },
      { k: 'cmd', who: 'sam', text: 'echo "Q3 summary …" > /finance/q3.md' },
      { k: 'err', text: 'Originals are read-only. Write to /drafts/ and a person will move it.' },
      { k: 'cmd', who: 'sam', text: 'echo "Q3 summary …" > /drafts/q3.md' },
      { k: 'ok', text: '✓ Saved to /drafts/q3.md — contains content from /finance' },
    ] as TermLine[],
  },
  // Product mock in the hero: the web app's Files view with "who can see" for the selected folder.
  mock: {
    label: 'Trina Drive web app: the Files view, with who can see the finance folder',
    url: 'drive.office.lan',
    nav: ['Files', 'Drafts', 'Audit log', 'Connections'],
    crumb: 'All folders',
    search: 'Search inside PDF, Office and more…',
    cols: { name: 'Name', access: 'NAS access', ai: 'AI' },
    rows: [
      { name: 'finance', access: 'Finance team', ai: 'on', selected: true },
      { name: 'contracts', access: 'Everyone', ai: 'on' },
      { name: 'projects', access: 'Everyone', ai: 'on' },
      { name: 'shared', access: 'Everyone', ai: 'on' },
      { name: 'hr', access: 'HR', ai: 'off' },
    ],
    aiOn: 'AI on',
    aiOff: 'No AI',
    panel: {
      title: 'Who can see finance',
      nasLabel: 'Opens on the NAS',
      nas: ['Sam', 'Jordan'],
      aiLabel: 'Whose AI may read it',
      ai: 'Finance team',
      hiddenLabel: 'Hidden from',
      hidden: 'Everyone outside Finance — for them it does not exist',
      draftLabel: 'Latest draft',
      draft: '/drafts/q3.md',
      draftFrom: 'from finance',
      logLabel: 'Last access',
      log: 'Sam · Claude Code · grep -ri revenue /',
    },
  },
  proof: [
    { icon: 'user', text: 'Built for teams of 5 to 20' },
    { icon: 'folder', text: 'No uploads, nothing to index' },
    { icon: 'shield', text: 'Every security feature free' },
  ],
  clients: {
    // Heading of the MCP marquee (A credibility band, B band under the hero).
    title: 'Works with any AI that speaks MCP',
    today: 'today',
    soon: 'v0.2 · rolling out',
    items: [
      { name: 'Claude Code', status: 'today' },
      { name: 'Codex', status: 'today' },
      { name: 'Cursor', status: 'today' },
      { name: 'claude.ai', status: 'soon' },
      { name: 'ChatGPT', status: 'soon' },
    ],
    // The marquee (components/Marquee.astro): MCP clients that can add a remote MCP server by URL (checked against
    // each vendor's docs 2026-10-23; see LOGO-SOURCES.md). Which mark each one gets: content/brands.ts.
    any: [
      'Claude Code', 'Claude', 'Codex', 'ChatGPT', 'Cursor', 'Grok', 'Gemini CLI', 'Devin Desktop (Windsurf)',
      'VS Code + Copilot', 'Zed', 'Cline', 'goose', 'LM Studio',
    ],
    rollout: 'Claude and ChatGPT web connectors: rolling out (v0.2).',
    // Shown next to the logos (A band, B "works" section). Logo rules: LOGO-SOURCES.md.
    trademarks: 'Trademarks belong to their owners; Trina Drive is not affiliated with or endorsed by them.',
  },
  // One compact comparison: an ontology/RAG build vs. a cloud-drive connector vs. Trina Drive.
  // No dollar figures for ontology projects. Don't claim connectors can't read files: they read one at a time.
  compare: {
    eyebrow: 'Why folders',
    title: 'No ontology project. No one-file connector.',
    sub: 'Search every folder at once, where the files already live.',
    cols: ['Ontology / RAG', 'Drive connector', 'Trina Drive'],
    rows: [
      { label: 'To get started', cells: ['Months of modeling', 'Files in Google Drive first', 'Point at your folders'] },
      { label: 'To search everything', cells: ['Pre-cut chunks', 'Reads one file at a time', 'grep -r, every folder at once'] },
      { label: 'When a file changes', cells: ['Re-embed, re-index', 'Read it again', 'Next search sees it'] },
    ],
    demoLabel: 'One search, every folder',
    demo: ['$ grep -ri "renewal date" /', '/contracts/acme_supply_2026.pdf: Renewal date: 2027-03-31', '/projects/globex/sow_v2.docx: …the renewal date shall be…', '/shared/vendors.xlsx: Northwind | renewal date | 2026-12-01'],
    types: ['PDF', 'DOCX', 'XLSX', 'PPTX', 'HWP'],
  },
  // Benchmark section. Data-driven: fill in the numbers and set enabled: true. Hidden while enabled is false.
  // approaches: one bar each (value 0–100, in `unit`); the `us` entry gets the accent colour. byType: a small table.
  benchmark: {
    enabled: false,
    eyebrow: 'Benchmark',
    title: 'Direct search vs. RAG vs. a drive connector',
    sub: 'Same model, same questions, a ~400-file corpus of PDFs, Office files and more.',
    stat: { value: '00%', label: 'placeholder — headline stat, e.g. more questions answered correctly than chunk-based RAG' },
    metric: 'Answer accuracy',
    unit: '%',
    approaches: [
      { name: 'Trina Drive (direct agentic search)', value: 0, us: true },
      { name: 'Chunk-based RAG', value: 0, us: false },
      { name: 'Search-and-read connector', value: 0, us: false },
    ],
    byType: {
      title: 'By question type',
      cols: ['Question type', 'Trina Drive', 'RAG', 'Connector'],
      rows: [
        { label: 'Exact lookup (a clause, a number)', cells: ['—', '—', '—'] },
        { label: 'Across many files', cells: ['—', '—', '—'] },
        { label: 'Tables and spreadsheets', cells: ['—', '—', '—'] },
      ],
    },
    link: { text: 'Method & data on GitHub', href: 'https://github.com/potenlab/trina-drive' },
    note: 'Placeholder — replace with the method summary (model, corpus, scoring).',
  },
  // Competitor table for a 5–20 person team. Data-driven: one row per product; hidden while enabled is false.
  // The first row is Trina Drive (highlighted). cols are the column headings after "Product".
  competitors: {
    enabled: false,
    eyebrow: 'Compare',
    title: 'For a team of 5 to 20, side by side',
    caption: 'Trina Drive compared with other AI knowledge tools for a small team',
    cols: ['Setup effort', 'How files get in', 'How AI finds answers', 'Per-person access', 'Where data lives', 'Price for a 10-person team'],
    rows: [
      { name: 'Trina Drive', us: true, cells: ['—', '—', '—', '—', '—', '—'] },
      { name: 'ChatGPT / Claude Projects', us: false, cells: ['—', '—', '—', '—', '—', '—'] },
      { name: 'Notion AI', us: false, cells: ['—', '—', '—', '—', '—', '—'] },
      { name: 'Dust', us: false, cells: ['—', '—', '—', '—', '—', '—'] },
      { name: 'Onyx', us: false, cells: ['—', '—', '—', '—', '—', '—'] },
      { name: 'AnythingLLM', us: false, cells: ['—', '—', '—', '—', '—', '—'] },
      { name: 'Glean', us: false, cells: ['—', '—', '—', '—', '—', '—'] },
    ],
    note: 'Based on public documentation as of October 2026. Something out of date? Write to us and we will fix it.',
  },
  // Safe to share: scope, originals, record (cards with a command), then the limits in three lines. The full promise
  // (word for word) lives on /security.
  pillars: {
    eyebrow: 'Safe to share',
    title: 'Shared with the whole team, safely.',
    items: [
      {
        icon: 'filter',
        label: 'Scope',
        title: 'Each person’s AI sees only what they may.',
        body: '',
        cmd: 'tdrive mcp add claude --read-only --ttl 7d',
      },
      {
        icon: 'draft',
        label: 'Originals',
        title: 'Through Trina Drive, agents write drafts, not originals.',
        body: '',
        cmd: 'echo hi > /projects/README.md',
        out: 'Originals are read-only. Write to /drafts/ and a person will move it.',
      },
      {
        icon: 'log',
        label: 'Record',
        title: 'Every read is logged.',
        body: '',
        cmd: 'tdrive audit verify',
      },
    ],
  },
  features: {
    eyebrow: 'What you get',
    title: 'Ask in plain words. Your agent digs.',
    // Text inside the small product illustrations on each card (decorative; the card text says it in words).
    minis: {
      filter: {
        cmd: 'ls /',
        rows: [
          { who: 'alex', role: 'member', out: 'alex/  contracts/  projects/  shared/' },
          { who: 'sam', role: 'finance', out: 'contracts/  finance/  projects/  sam/  shared/' },
        ],
        rule: 'person’s rules ∩ token scope',
      },
      draft: {
        file: 'q3.md',
        path: '/drafts/',
        sourcesLabel: 'Sources',
        sources: ['finance', 'projects'],
        visible: 'Visible only to tokens that can read both',
        move: 'Move to shared',
        moveNote: 'needs a person',
      },
      shell: {
        lines: ['$ grep -rl "unit price" /projects | head -2', '/projects/acme/quote_v3.xlsx', '/projects/globex/quote.pdf'],
        chips: ['no network', 'time limit', 'memory limit', 'ripgrep'],
      },
      log: {
        rows: [
          { t: '14:02:11', who: 'Sam', via: 'Claude Code', cmd: 'grep -ri revenue /', h: 'a41f' },
          { t: '14:02:48', who: 'Sam', via: 'Claude Code', cmd: 'cat /finance/board_memo.pdf', h: '9c07' },
          { t: '14:05:30', who: 'Alex', via: 'Cursor', cmd: 'ls /projects', h: 'e2d8' },
        ],
        anchor: 'Chain head signed and sent out daily',
      },
      nas: {
        device: 'Mac mini in the office',
        shares: ['NAS · finance', 'NAS · projects', 'NAS · shared', 'Mac · scans'],
        apps: 'Finder · Explorer · Office',
      },
      search: {
        types: ['PDF', 'DOCX', 'XLSX', 'PPTX'],
        query: 'grep -r "warranty" /',
        hit: '/projects/acme/contract_2026.pdf',
        line: '…a warranty period of 24 months from delivery…',
      },
    },
    items: [
      {
        icon: 'search',
        title: 'grep inside PDF and Office files',
        body: 'PDF, Word, Excel, PowerPoint, even HWP. Scans: OCR in v0.3.',
      },
      {
        icon: 'shell',
        title: 'The commands agents already know',
        body: 'ls, grep -r, cat and pipes, over a virtual tree.',
      },
      {
        icon: 'nas',
        title: 'No migration. Your NAS stays as it is.',
        body: 'Nothing moves, nothing is copied to us.',
      },
    ],
  },
  how: {
    eyebrow: 'How it works',
    title: 'Three steps. No migration.',
    steps: [
      { title: 'Install on a Mac mini, register folders', body: 'Pick NAS folders. Choose whose AI may read each.' },
      { title: 'Each person connects their AI', body: 'One command. Personal token, 7 days, in the Keychain.', code: 'tdrive mcp add claude --server https://drive.office.lan --login alex' },
      { title: 'Agents work. You see everything.', body: 'Drafts with sources, every call logged, revoke anytime.' },
    ],
    diagram: {
      people: 'Your people and their AI',
      peopleItems: ['Claude Code', 'Codex', 'Cursor', 'claude.ai · ChatGPT (v0.2)'],
      peopleNote: 'Personal token or OAuth, per person',
      server: 'Trina Drive on your Mac mini',
      serverItems: ['Permission filter (one function)', 'Isolated shell · read · drafts', 'Audit log + signed anchor'],
      serverNote: 'Storage, decisions and logs stay here',
      folders: 'Your folders, as they are',
      folderItems: ['NAS shares — read-only', 'Local folders — read-only', '/drafts/ — on the server'],
      folderNote: 'People keep using Finder, Explorer and Office',
      arrow1: 'MCP',
      arrow2: 'read-only',
      noAi: '“No AI” folders — never reached',
      label: 'How a request flows: your people’s AI tools connect over MCP to Trina Drive on your Mac mini, which checks permissions and reads your folders read-only.',
    },
  },
  security: {
    // Shown word for word on /security (plan §7.2). The home pages show only the three limits below and link there.
    promiseLabel: 'Our promise, word for word',
    promise: [
      'Storage, permission decisions and the logs are on your server. What an agent reads goes to the AI company that made that agent (Anthropic, OpenAI and others).',
      'Mark folders where that must not happen as “No AI”. Personal folders cannot be read secretly, not even by admins (unregistering one or changing its owner notifies the owner), but whoever runs the server — for managed plans, our operators — can see the disk.',
    ],
    limitsTitle: 'What it doesn’t do',
    limits: [
      'What AI reads goes to its provider; use “No AI” folders.',
      'Covers access through Trina Drive only.',
      'Doesn’t stop prompt injection; it narrows and logs.',
    ],
    link: 'Promises and limits, in full',
  },
  pricing: {
    eyebrow: 'Pricing',
    title: 'Self-hosted free forever.\nPay us to run it.',
    sub: 'Managed plans count only AI-connected people.',
    usdNote: 'Billed in US dollars (USD).',
    billingLabel: 'Billing period',
    monthly: 'Monthly',
    yearly: 'Yearly',
    yearlyBadge: '2 months free',
    seatsLabel: 'AI-connected people',
    trialNote: '14-day Team trial after a setup call.',
    perMonth: '/ month',
    popular: 'Most teams',
    plans: [
      {
        id: 'community',
        name: 'Community',
        kind: 'Self-hosted',
        price: { USD: '$0', KRW: '₩0' },
        unit: { USD: 'forever', KRW: 'forever' },
        annual: { USD: '', KRW: '' },
        features: ['The full product', 'Every security feature', 'Unlimited people and folders', 'Community support on GitHub'],
        cta: 'Self-host it',
        ctaKind: 'link',
      },
      {
        id: 'team',
        name: 'Team',
        kind: 'Managed',
        price: { USD: '$99', KRW: '₩129,000' },
        unit: { USD: '/ month', KRW: '/ month' },
        annual: { USD: 'or $990 / year', KRW: 'or ₩1,290,000 / year' },
        yearly: {
          price: { USD: '$990', KRW: '₩1,290,000' },
          unit: { USD: '/ year', KRW: '/ year' },
          note: { USD: '2 months free vs. monthly', KRW: '2 months free vs. monthly' },
        },
        features: [
          'Installed and run on your Mac mini',
          'Up to 10 AI-connected people',
          'Extra AI-connected person: {extra}',
          'Email support, next business day',
        ],
        extra: {
          monthly: { USD: '$9 / month', KRW: '₩12,000 / month' },
          yearly: { USD: '$90 / year', KRW: '₩120,000 / year' },
        },
        seats: 10,
        cta: 'Start a 14-day trial',
        ctaPay: 'Start a 14-day trial',
        ctaKind: 'checkout',
        featured: true,
      },
      {
        id: 'business',
        name: 'Business',
        kind: 'Managed',
        price: { USD: '$349', KRW: '₩449,000' },
        unit: { USD: '/ month', KRW: '/ month' },
        annual: { USD: 'or $3,490 / year', KRW: 'or ₩4,490,000 / year' },
        yearly: {
          price: { USD: '$3,490', KRW: '₩4,490,000' },
          unit: { USD: '/ year', KRW: '/ year' },
          note: { USD: '2 months free vs. monthly', KRW: '2 months free vs. monthly' },
        },
        features: [
          'Everything in Team',
          'Up to 40 AI-connected people (+{extra} each beyond)',
          '4-business-hour response',
          'Quarterly access review · setup free on annual',
        ],
        extra: {
          monthly: { USD: '$7 / month', KRW: '₩9,000 / month' },
          yearly: { USD: '$70 / year', KRW: '₩90,000 / year' },
        },
        seats: 40,
        cta: 'Talk to us',
        ctaPay: 'Get Business',
        ctaKind: 'checkout',
      },
      {
        id: 'setup',
        name: 'Setup & migration',
        kind: 'One-time',
        price: { USD: 'from $1,490', KRW: 'from ₩1,900,000' },
        unit: { USD: '', KRW: '' },
        annual: { USD: '', KRW: 'On-site in Korea available' },
        features: ['Folder & permission design', 'NAS / Mac mini setup', 'Client connection training'],
        cta: 'Book setup',
        ctaKind: 'checkout',
      },
    ],
  },
  faq: {
    eyebrow: 'FAQ',
    title: 'Questions, answered plainly',
    more: 'Something else?',
    moreBody: 'A person answers within one business day.',
    items: [
      {
        q: 'How is this different from RAG or a knowledge graph?',
        a: 'Nothing to model, chunk or embed. Agents grep your folders and read the files, so a change shows up on the next search.',
      },
      {
        q: 'Why not mount the NAS and run Claude Code?',
        a: 'That shell is real. A mount can’t give you per-person scope, read-only originals, search inside PDF and Office files, or a shared read log.',
      },
      {
        q: 'A simulated shell isn’t bash.',
        a: 'Right: no python, curl or real processes, on purpose. The same commands (ls, grep -r, cat, pipes), over only the files you allow.',
      },
      {
        q: 'Doesn’t the data go to Anthropic or OpenAI anyway?',
        a: 'What an agent reads goes to the AI company its person chose. Mark folders “No AI” and agents can’t see them at all.',
      },
      {
        q: 'Does it follow my NAS permissions?',
        a: 'No. You choose per folder whose AI may read it, and a new folder is hidden from every AI until you do.',
      },
      {
        q: 'Is it open source?',
        a: 'Yes, under the Apache-2.0 license: server, CLI and web app. Every security feature stays free and self-hostable.',
        link: { text: 'Read the license', href: 'https://github.com/potenlab/trina-drive/blob/main/LICENSE' },
      },
    ],
  },
  cta: {
    title: 'An AI knowledge base, without building one.',
    sub: 'Free to self-host, or we run it on your office Mac mini.',
    primary: 'View on GitHub',
    secondary: 'Book a setup call',
    install: 'Install guide',
  },
  footer: {
    tagline: 'Your company folders, as your team’s AI knowledge base.',
    product: 'Product',
    resources: 'Resources',
    legal: 'Legal',
    links: {
      features: 'Features',
      how: 'How it works',
      pricing: 'Pricing',
      security: 'Security',
      faq: 'FAQ',
      docs: 'Docs',
      github: 'GitHub',
      securityModel: 'Security model',
      contact: 'Contact',
      terms: 'Terms of Service',
      privacy: 'Privacy Policy',
      refund: 'Refund Policy',
    },
    copyright: '© 2026 Trina Inc.',
  },
  legal: {
    back: 'Back to home',
    updated: 'Last updated:',
    terms: { title: 'Terms of Service', description: 'Terms for Trina Drive managed plans and setup services, provided by Trina Inc.' },
    privacy: { title: 'Privacy Policy', description: 'What personal information Trina Inc. collects for Trina Drive, why, and your rights.' },
    refund: { title: 'Refund Policy', description: 'Trina Drive refunds: 14-day window, annual plans, setup services and how to ask.' },
  },
  thanks: {
    title: 'Thank you — your order is in',
    lead: 'Payment received. Paddle, our reseller and Merchant of Record, emails your receipt and invoice.',
    steps: [
      'Within one business day we email you to schedule the installation on your office Mac mini.',
      'Look up the order, update your card or download invoices any time at paddle.net.',
      'Questions or changes: write to us and we answer within one business day.',
    ],
    back: 'Back to home',
  },
  // /security: the page behind the home page's promises (structure from the positioning report).
  securityPage: {
    title: 'Security — what Trina Drive promises, and where it stops',
    description: 'Trina Drive’s guarantees, its known limits, the line between self-hosted and managed, and how to report a vulnerability.',
    eyebrow: 'Security',
    h1: 'What we promise, and where it stops.',
    lead: 'Trina Drive does not try to make an AI agent trustworthy. It limits what any one agent connection can reach, keeps originals out of its reach, and records what it read. These are the promises, and the limits that come with them.',
    guaranteesTitle: 'Five guarantees',
    guarantees: [
      { title: 'Through Trina Drive, nobody writes to originals — admins included.', why: 'The only write path is the draft box. Promoting a draft creates a new file and never overwrites one.' },
      { title: 'An agent never sees more than its person.', why: 'Agent view = the person’s AI rules ∩ the token’s scope, decided in one function that the shell, file tools, search and web downloads all call.' },
      { title: 'A hidden folder looks exactly like a missing one.', why: 'Same output, same error, same exit code — so names outside an agent’s view don’t leak.' },
      { title: 'A newly registered folder is visible to no AI.', why: 'Every registered folder starts at “nobody” until you choose whose AI may read it.' },
      { title: 'A rewritten audit log gets caught.', why: 'Every call lands in a hash chain; its signed head is sent off the server, and tdrive audit verify checks the history against it.' },
    ],
    promiseTitle: 'Our promise, word for word',
    limitsTitle: 'Known limits',
    limitsLead: 'We publish these so you can decide with the full picture. The complete, technical list is in the security model.',
    limits: [
      'What an agent reads goes to the AI provider its person chose. Mark folders where that must not happen as “No AI”.',
      'Guarantees cover access through Trina Drive only. A laptop that mounts the NAS directly goes around it; for people who use AI, connect through Trina Drive instead of a mount.',
      'It does not stop prompt injection. It narrows what an agent can reach, labels drafts with their sources, alerts on bulk reads and logs every call.',
      'Copies made through an agent’s memory or local files, or moved to shares you have not registered, are not caught.',
      'NAS permissions are not read automatically, so the NAS and the AI rules can disagree. Sub-folder permissions set on the NAS are not known.',
      'Small gaps remain: timing differences between hidden and missing paths are not equalised, and a folder is re-checked around a write rather than atomically with it.',
      'On managed plans, our operators can see the server’s disk.',
    ],
    boundaryTitle: 'Self-hosted and managed',
    boundary: [
      { title: 'Self-hosted', body: 'You run the software on your own Mac mini or Linux box. Storage, permission decisions and logs stay on your server, and we have no access.' },
      { title: 'Managed', body: 'The same software, operated by us on your office Mac mini: install, monitoring, updates, backups and hardening. Our operators can see the server’s disk.' },
    ],
    reviewTitle: 'Review and disclosure',
    review: [
      { title: 'External review', body: 'An external security review is part of our release gate and is in progress. When it is done we will publish who reviewed it and what was in scope.' },
      { title: 'Report a vulnerability', body: 'Email security@trina.app rather than opening a public issue. We reply within 72 hours.' },
      { title: 'Fixes for everyone at once', body: 'Security fixes are released to every installation at the same time, self-hosted and managed alike.' },
    ],
    modelLink: 'Full security model on GitHub',
    reportEmail: 'security@trina.app',
    back: 'Back to home',
  },
  notFound: { title: 'Page not found', body: 'That page does not exist — or you are not allowed to see it.', back: 'Go home' },
}

export default en
export type Copy = typeof en
