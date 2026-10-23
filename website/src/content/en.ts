// Site copy (English only). Facts come from the repo README, docs/ARCHITECTURE.md (managed storage), the security
// model, cloud/README.md and research/trina-drive/PRICING.md. Do not add features the product does not have; anything
// built but not yet proven with real customers is labelled "Beta". Demo names, companies, files and numbers are fictional.
//
// Business model (owner, 2026-10-23), structured like supabase.com: Trina Cloud (we host it) is the main product; the
// same software is open source (Apache-2.0) and free to self-host; on-site installs are Enterprise only.

const en = {
  lang: 'en' as 'en' | 'ko',
  // title ≤ 60 and description ≤ 155 characters (search results cut the rest; test/seo.test.ts checks every page).
  meta: {
    title: 'Trina Drive — AI knowledge base & team drive for AI',
    description:
      'The team drive your AI can read. Claude, ChatGPT, Cursor or any MCP app searches your team’s files with each person’s permissions. Hosted or open source.',
    // Longer summary for structured data and /llms.txt.
    long:
      'A team drive like Google Drive, where each person’s AI (Claude, ChatGPT, Codex, Cursor) can search and read the files that person may open. Hosted on Trina Cloud, or open source (Apache-2.0) to self-host free.',
    ogImage: '/og.png',
    ogAlt: 'Trina Drive: the team drive your AI can read',
  },
  skip: 'Skip to content',
  nav: {
    product: 'Product',
    openSource: 'Open source',
    docs: 'Docs',
    github: 'GitHub',
    pricing: 'Pricing',
    security: 'Security',
    faq: 'FAQ',
    signIn: 'Sign in',
    start: 'Request access',
    theme: 'Toggle dark mode',
    menu: 'Menu',
  },
  // The H1 is two parts so the second can carry the accent gradient.
  hero: {
    pill: 'Trina Cloud · early access',
    title: 'The team drive',
    titleAccent: 'your AI can read.',
    sub: 'Keep your team’s files in one drive. Ask Claude or ChatGPT about them. Everyone’s AI sees only what they may.',
    // primary is the same words either way; while CLOUD_LIVE is false (src/site.ts) it opens the console's
    // early-access request (cloud.trina.app/signup).
    primary: 'Start your team drive',
    note: 'Early access: we’re onboarding the first teams now.',
    noteLive: 'Start free. Upgrade when your team grows.',
    secondary: 'Self-host',
    copy: 'Copy',
    copied: 'Copied',
  },
  // Hero product mock: the web app's Files view with "who can see" for the selected folder.
  mock: {
    label: 'Trina Drive web app: team folders, who can open each one and whose AI may read it',
    url: 'acme.cloud.trina.app',
    nav: ['Files', 'Drafts', 'Trash', 'Audit log'],
    storage: '12.4 GB of 100 GB',
    upload: 'Upload',
    crumb: 'All folders',
    search: 'Search inside PDF, Office, HWP…',
    cols: { name: 'Name', access: 'Who can open', ai: 'AI' },
    rows: [
      { name: 'Finance', access: 'Finance team', ai: 'on', selected: true },
      { name: 'Contracts', access: 'Everyone', ai: 'on' },
      { name: 'Projects', access: 'Everyone', ai: 'on' },
      { name: 'Shared', access: 'Everyone', ai: 'on' },
      { name: 'HR', access: 'HR', ai: 'off' },
    ],
    aiOn: 'AI on',
    aiOff: 'No AI',
    panel: {
      title: 'Who can see Finance',
      openLabel: 'Can open',
      open: ['Sam', 'Jordan'],
      aiLabel: 'Whose AI may read it',
      ai: 'Finance team',
      hiddenLabel: 'Hidden from',
      hidden: 'Everyone else — for them it does not exist',
      logLabel: 'Last read',
      log: 'Sam · Claude · board-memo-Q3.pdf',
    },
  },
  // Hero chat card (variant A): one question answered from the files, and the same question from someone who may not
  // see them. A neutral AI app, no vendor branding.
  chatCard: {
    label: 'Demo: Sam from Finance asks an AI app about Q3 revenue and gets an answer with its sources; Alex from Design asks the same and the Finance folder does not exist for Alex’s AI.',
    app: 'Your AI app',
    connected: 'Trina Drive connected',
    turns: [
      {
        who: 'Sam',
        team: 'Finance',
        q: 'Summarize Q3 revenue from our finance files.',
        status: 'Searched company files · read 2',
        a: 'Q3 revenue was $1.42M, up 8.4% on Q2. Main driver: two new retainer clients from August.',
        sources: ['Finance/2026-Q3-close.xlsx', 'Finance/board-memo-Q3.pdf'],
      },
      {
        who: 'Alex',
        team: 'Design',
        q: 'Summarize Q3 revenue from our finance files.',
        status: 'Searched company files',
        a: 'I couldn’t find any finance files you have access to.',
        sources: [],
      },
    ],
    sourcesLabel: 'Sources',
  },
  clients: {
    // Heading of the MCP marquee (both variants).
    title: 'Works with the AI your team already uses',
    // The marquee (components/Marquee.astro): MCP clients that can add a remote MCP server by URL (checked against
    // each vendor's docs 2026-10-23; see LOGO-SOURCES.md). Which mark each one gets: content/brands.ts.
    any: [
      'Claude Code', 'Claude', 'Codex', 'ChatGPT', 'Cursor', 'Grok', 'Gemini CLI', 'Devin Desktop (Windsurf)',
      'VS Code + Copilot', 'Zed', 'Cline', 'goose', 'LM Studio',
    ],
    rollout: 'Claude and ChatGPT web connectors: rolling out (v0.2).',
    trademarks: 'Trademarks belong to their owners; Trina Drive is not affiliated with or endorsed by them.',
  },
  // Product grid (supabase.com's product cards): what is built, then two "Beta" cards (built in PR #19, not yet tested
// against real Google credentials or real Finder / Explorer clients). The first card is wide and
  // carries the drive's features as chips.
  product: {
    eyebrow: 'AI knowledge base for teams',
    title: 'Everything a team drive needs.\nPlus your team’s AI.',
    beta: 'Beta',
    // Decorative upload illustration in the wide drive card.
    art: { drop: 'Drop files or folders', folder: 'site-photos/', progress: '64%', docs: [['board-memo-Q3.pdf', 'v3'], ['rate-card-2026.xlsx', 'v7']] },
    items: [
      {
        icon: 'folder',
        title: 'A drive your team already knows',
        body: 'Drag and drop files and whole folders. Big uploads pick up where they stopped.',
        chips: ['Rename, move, copy', 'Trash for 30 days', 'Version history', 'Storage per team'],
        wide: true,
      },
      {
        icon: 'sparkle',
        title: 'Every person’s AI, with their permissions',
        body: 'Claude, ChatGPT, Codex, Cursor or any MCP app reads only what its person may.',
      },
      { icon: 'eyeoff', title: 'Hidden means it doesn’t exist', body: 'A folder you can’t open never shows up. Not even its name.' },
      { icon: 'draft', title: 'AI writes drafts. People approve.', body: 'Through Trina Drive, AI never changes your originals.' },
      { icon: 'search', title: 'Search inside every file', body: 'PDF, Word, Excel, PowerPoint and HWP, all at once.' },
      { icon: 'log', title: 'Every read on the record', body: 'Each file an AI opens is logged. Approvals need a passkey.' },
      { icon: 'cloud', title: 'Import from Google Drive', body: 'Pick files. Docs, Sheets and Slides arrive as Word, Excel and PowerPoint.', beta: true },
      { icon: 'nas', title: 'Mount it as a drive', body: 'Open it in Finder or Windows Explorer, with the same permissions.', beta: true },
    ] as { icon: string; title: string; body: string; chips?: string[]; wide?: boolean; beta?: boolean }[],
  },
  how: {
    eyebrow: 'How it works',
    title: 'Three steps.\nNothing to install.',
    steps: [
      { title: 'Create your team drive', body: 'Sign up and invite your team.' },
      { title: 'Add your files', body: 'Drag and drop, or import from Google Drive (beta). Choose who sees each folder.' },
      { title: 'Connect your AI', body: 'Claude Code, Codex and Cursor today. Claude and ChatGPT: rolling out.' },
    ],
  },
  // Trina Cloud trust section. Design commitments for the hosted product (early access): keep the note saying so until
  // each one is live and documented on /security. No certification claims (no SOC 2 yet).
  cloud: {
    eyebrow: 'Trina Cloud',
    title: 'We host it.\nYou own it.',
    items: [
      { icon: 'lock', title: 'Your own isolated instance', body: 'A separate process, disk and keys for each team.' },
      { icon: 'shield', title: 'Encrypted', body: 'Encrypted disks and backups, TLS on every connection.' },
      { icon: 'eye', title: 'No peeking', body: 'Our staff open nothing without your approval. Every access is logged.' },
      { icon: 'arrow', title: 'Leave anytime', body: 'Export everything, or self-host the same open-source code.' },
    ],
    note: 'Design commitments for Trina Cloud, now in early access.',
    region: 'Hosting region: US (more regions later).',
    link: 'Security details',
  },
  // "Open source" section (supabase.com's open-source / self-hosting block).
  openSource: {
    eyebrow: 'Open source',
    title: 'Open source.\nSelf-host it free.',
    sub: 'The same Trina Drive under Apache-2.0. Run it on your own Mac mini or Linux server.',
    points: [
      'Every feature, no limits on people or storage',
      'Files stay on your own server',
      'Installers for macOS and Docker',
    ],
    primary: 'Star on GitHub',
    secondary: 'Self-hosting guide',
    repo: 'potenlab/trina-drive',
    license: 'Apache-2.0',
    lang: 'TypeScript',
    // docs/DOCKER.md, in order.
    cmds: [
      'git clone https://github.com/potenlab/trina-drive',
      'cd trina-drive && docker compose build',
      'docker compose run --rm trina-drive init',
      'docker compose up -d',
    ],
    devLabel: 'Developers',
    dev: 'Connect Claude Code, Codex or Cursor:',
    devCmd: 'tdrive mcp add claude',
  },
  // Benchmark section. Data-driven: fill in the numbers and set enabled: true. Hidden while enabled is false.
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
  security: {
    // Shown word for word on /security. The home pages show only the three limits below and link there.
    promiseLabel: 'Our promise, word for word',
    promise: [
      'Storage, permission decisions and the logs stay on one server: your own when you self-host, your team’s isolated instance on Trina Cloud. What an agent reads goes to the AI company that made that agent (Anthropic, OpenAI and others).',
      'Mark folders where that must not happen as “No AI”. Personal folders cannot be read secretly, not even by admins (unregistering one or changing its owner notifies the owner), but whoever runs the server can reach its disk: you when you self-host, our operators on Trina Cloud.',
    ],
    limitsTitle: 'What it doesn’t do',
    limits: [
      'What AI reads goes to its provider; use “No AI” folders.',
      'Covers access through Trina Drive only.',
      'Doesn’t stop prompt injection; it narrows and logs.',
    ],
    link: 'Promises and limits, in full',
  },
  // Pricing (supabase.com/pricing): Free, Team, Business, Enterprise as cards, self-hosting as a bar under them.
  // Paddle price IDs (team/business) are unchanged; plan ids match src/checkout.ts ('setup' = Enterprise / on-site).
  pricing: {
    eyebrow: 'Pricing',
    title: 'Start free.\nGrow when you’re ready.',
    sub: 'Paid plans count only the people who connect an AI.',
    usdNote: 'Prices in US dollars.',
    // earlyNote while CLOUD_LIVE is false (src/site.ts), trialNote once it is true.
    earlyNote: 'Early access: we’re onboarding the first teams now.',
    trialNote: '14-day free trial on Team.',
    billingLabel: 'Billing period',
    monthly: 'Monthly',
    yearly: 'Yearly',
    yearlyBadge: '2 months free',
    seatsLabel: 'People with AI',
    popular: 'Most teams',
    plans: [
      {
        id: 'free',
        name: 'Free',
        kind: 'To try it out',
        price: '$0',
        unit: '/ month',
        features: ['1 GB storage', 'Up to 3 people', 'Pauses after 7 days without activity', 'Community support'],
        cta: 'Request access',
        ctaLive: 'Start free',
      },
      {
        id: 'team',
        name: 'Team',
        kind: 'For teams up to 10',
        price: '$99',
        unit: '/ month',
        yearly: { price: '$990', unit: '/ year' },
        features: ['100 GB storage', 'Up to 10 people', 'Extra people: {extra} each', '14-day free trial', 'Email support'],
        extra: { monthly: '$9 / month', yearly: '$90 / year' },
        seats: 10,
        cta: 'Request access',
        ctaLive: 'Start a 14-day trial',
        featured: true,
      },
      {
        id: 'business',
        name: 'Business',
        kind: 'For growing teams',
        price: '$349',
        unit: '/ month',
        yearly: { price: '$3,490', unit: '/ year' },
        features: ['1 TB storage', 'Up to 40 people', 'Extra people: {extra} each', 'Priority support', 'Everything in Team'],
        extra: { monthly: '$7 / month', yearly: '$70 / year' },
        seats: 40,
        cta: 'Request access',
        ctaLive: 'Get Business',
      },
      {
        id: 'setup',
        name: 'Enterprise',
        kind: 'Cloud or on-site',
        price: 'Custom',
        unit: '',
        features: ['Installed on your own server', 'More people and storage', 'Folder & permission design', 'Team training'],
        cta: 'Contact us',
        ctaLive: 'Contact us',
      },
    ] as {
      id: 'free' | 'team' | 'business' | 'setup'
      name: string
      kind: string
      price: string
      unit: string
      yearly?: { price: string; unit: string }
      features: string[]
      extra?: { monthly: string; yearly: string }
      seats?: number
      cta: string
      ctaLive: string
      featured?: boolean
    }[],
    yearlyNote: '2 months free',
    monthlyNote: 'or {yearly}',
    self: {
      name: 'Self-hosted',
      price: '$0',
      unit: 'forever',
      body: 'Open source (Apache-2.0). Every feature, on your own Mac mini or server.',
      cta: 'Self-host on GitHub',
    },
  },
  faq: {
    eyebrow: 'FAQ',
    title: 'Questions,\nanswered plainly',
    more: 'Something else?',
    moreBody: 'A person answers within one business day.',
    items: [
      {
        q: 'What is Trina Drive?',
        a: 'A team drive that is also your team’s AI knowledge base. It works as an MCP file server: each person’s AI app (Claude, ChatGPT, Codex, Cursor or any MCP client) searches and reads only the files that person may open.',
      },
      {
        q: 'Is it a Google Drive alternative?',
        a: 'For files your AI should read, yes: folders, versions and trash, plus AI access per person. You can import from Google Drive (beta).',
        link: { text: 'Trina Drive vs Google Drive', href: '/compare/google-drive' },
      },
      {
        q: 'What is Trina Cloud?',
        a: 'Trina Drive, hosted by us. Your team gets its own isolated instance in the US. Nothing to install.',
      },
      {
        q: 'Is there a free plan?',
        a: 'Yes: 1 GB and up to 3 people. Free drives pause after 7 days without activity; paid plans don’t.',
      },
      {
        q: 'Can we host it ourselves?',
        a: 'Yes, free forever. The whole product is open source under Apache-2.0, every security feature included.',
        link: { text: 'Read the license', href: 'https://github.com/potenlab/trina-drive/blob/main/LICENSE' },
      },
      {
        q: 'Which AI apps work?',
        a: 'Claude Code, Codex and Cursor today. Claude and ChatGPT connectors are rolling out. Any app that speaks MCP works too.',
      },
      {
        q: 'Do you train AI on our files?',
        a: 'No. What an AI reads goes to the AI company its person uses, under that company’s terms. Mark folders “No AI” to keep them out.',
      },
      {
        q: 'Can the AI change or delete our files?',
        a: 'Not through Trina Drive. AI writes drafts, and a person decides where they go.',
      },
      {
        q: 'Can we leave?',
        a: 'Anytime. Export everything, or move to self-hosting: it’s the same code.',
      },
    ] as { q: string; a: string; link?: { text: string; href: string } }[],
  },
  cta: {
    title: 'Start in the cloud.\nOr host it yourself.',
    sub: 'Trina Cloud is in early access. Self-hosting is free.',
    subLive: 'Start free on Trina Cloud. Self-hosting is free.',
    primary: 'Start your team drive',
    secondary: 'Self-host',
  },
  footer: {
    tagline: 'The team drive your AI can read.',
    product: 'Product',
    resources: 'Resources',
    legal: 'Legal',
    links: {
      product: 'Features',
      openSource: 'Open source',
      pricing: 'Pricing',
      faq: 'FAQ',
      security: 'Security',
      docs: 'Docs',
      github: 'GitHub',
      selfHost: 'Self-hosting guide',
      compare: 'Trina Drive vs Google Drive',
      terms: 'Terms of Service',
      privacy: 'Privacy Policy',
      refund: 'Refund Policy',
    },
    copyright: '© 2026 Trina Inc.',
    trust: 'Status & trust',
  },
  legal: {
    back: 'Back to home',
    updated: 'Last updated:',
    terms: { title: 'Terms of Service', description: 'Terms for Trina Cloud and Enterprise (on-site) services for Trina Drive, provided by Trina Inc.' },
    privacy: { title: 'Privacy Policy', description: 'What personal information Trina Inc. collects for Trina Drive, why, and your rights.' },
    refund: { title: 'Refund Policy', description: 'Trina Drive refunds: 14-day window, annual plans, Enterprise services and how to ask.' },
  },
  thanks: {
    title: 'Thank you — your order is in',
    lead: 'Payment received. Paddle, our reseller and Merchant of Record, emails your receipt and invoice.',
    steps: [
      'Within one business day we email you to set up your team drive.',
      'Look up the order, update your card or download invoices any time at paddle.net.',
      'Questions or changes: write to us and we answer within one business day.',
    ],
    back: 'Back to home',
  },
  // /security: the page behind the home page's promises.
  securityPage: {
    title: 'Security — what Trina Drive promises, and where it stops',
    description: 'Trina Drive’s five security guarantees, its known limits, Trina Cloud vs self-hosted vs on-site, and how to report a vulnerability.',
    ogImage: '/og/security.png',
    ogAlt: 'Trina Drive security: what we promise, and where it stops',
    eyebrow: 'Security',
    h1: 'What we promise, and where it stops.',
    lead: 'Trina Drive does not try to make an AI agent trustworthy. It limits what any one agent connection can reach, keeps originals out of its reach, and records what it read. These are the promises, and the limits that come with them.',
    guaranteesTitle: 'Five guarantees',
    guarantees: [
      { title: 'Through Trina Drive, no AI writes to originals.', why: 'An agent’s only write path is its draft box. A person moves a draft into a team folder, and if more people would see it, someone approves it first, with a passkey or an authenticator app.' },
      { title: 'An agent never sees more than its person.', why: 'Agent view = the person’s AI rules ∩ the token’s scope, decided in one function that the shell, file tools, search and web downloads all call.' },
      { title: 'A hidden folder looks exactly like a missing one.', why: 'Same output, same error, same exit code — so names outside an agent’s view don’t leak.' },
      { title: 'A new folder is visible to no AI.', why: 'Every folder starts at “nobody” until you choose whose AI may read it.' },
      { title: 'A rewritten audit log gets caught.', why: 'Every call lands in a hash chain; its signed head is sent off the server, and tdrive audit verify checks the history against it.' },
    ],
    promiseTitle: 'Our promise, word for word',
    limitsTitle: 'Known limits',
    limitsLead: 'We publish these so you can decide with the full picture. The complete, technical list is in the security model.',
    limits: [
      'What an agent reads goes to the AI provider its person chose. Mark folders where that must not happen as “No AI”.',
      'Guarantees cover access through Trina Drive only. When you self-host over an office NAS, a laptop that mounts the NAS directly goes around it.',
      'It does not stop prompt injection. It narrows what an agent can reach, labels drafts with their sources, alerts on bulk reads and logs every call.',
      'Copies made through an agent’s memory or local files are not caught.',
      'Self-hosted over a NAS: NAS permissions are not read automatically, so the NAS and the AI rules can disagree.',
      'Small gaps remain: timing differences between hidden and missing paths are not equalised, and a folder is re-checked around a write rather than atomically with it.',
      'When we operate the server (Trina Cloud or an Enterprise on-site install), our operators can reach its disk. On Trina Cloud, by design, only with your approval and logged.',
    ],
    boundaryTitle: 'Where it runs',
    boundary: [
      { title: 'Trina Cloud (early access)', body: 'The same software, hosted by us in the US: one isolated instance per team, with its own process, disk and keys. Design commitments: encrypted at rest and in transit, staff access only with your approval and in your audit log, export anytime.' },
      { title: 'Self-hosted', body: 'You run the open-source software on your own Mac mini or Linux server. Storage, permission decisions and logs stay on your server, and we have no access.' },
      { title: 'Enterprise on-site', body: 'The same software, installed by us on your own server, under a separate agreement. Who operates it, and so who can reach its disk, is set in that agreement.' },
    ],
    reviewTitle: 'Review and disclosure',
    review: [
      { title: 'External review', body: 'An external security review is part of our release gate and is in progress. When it is done we will publish who reviewed it and what was in scope.' },
      { title: 'Report a vulnerability', body: 'Email security@trina.app rather than opening a public issue. We reply within 72 hours.' },
      { title: 'Fixes for everyone at once', body: 'Security fixes are released to every installation at the same time: Trina Cloud, self-hosted and on-site alike.' },
    ],
    modelLink: 'Full security model on GitHub',
    reportEmail: 'security@trina.app',
    back: 'Back to home',
  },
  // /compare/google-drive. Google Drive facts are limited to what Google and the AI vendors document publicly; nothing
  // about speed or answer quality. Re-check before changing, and keep the "as of" note.
  compareGd: {
    title: 'Trina Drive vs Google Drive for AI teams',
    description: 'Trina Drive vs Google Drive when your team’s AI apps (Claude, ChatGPT, Cursor) should read your files: hosting, open source, AI access, price.',
    ogImage: '/og/compare-google-drive.png',
    ogAlt: 'Trina Drive vs Google Drive for AI teams',
    crumb: 'Trina Drive vs Google Drive',
    eyebrow: 'Compare',
    h1: 'Trina Drive vs Google Drive for AI teams',
    lead: 'Google Drive is a general-purpose drive with Google’s editors built in. Trina Drive is a team drive built for the AI apps your team already uses: each person’s AI reads only what that person may, and every read is logged.',
    tableTitle: 'At a glance',
    caption: 'Trina Drive compared with Google Drive',
    cols: ['Trina Drive', 'Google Drive'],
    rows: [
      { label: 'Made for', cells: ['Team files that each person’s AI should read', 'File storage and real-time editing in Docs, Sheets and Slides'] },
      { label: 'Where it runs', cells: ['Trina Cloud (US), or your own server', 'Google’s cloud'] },
      { label: 'Open source', cells: ['Yes, Apache-2.0. Self-hosting is free', 'No'] },
      { label: 'AI apps', cells: ['Claude Code, Codex, Cursor and any MCP client today; Claude and ChatGPT connectors rolling out', 'Gemini built in on eligible Google Workspace plans; ChatGPT and Claude offer their own Google Drive connectors'] },
      { label: 'What a connected AI can see', cells: ['Only folders its person may open and that allow that person’s AI. New folders start hidden from every AI', 'What the connected Google account can open'] },
      { label: 'Price', cells: ['Free; Team $99 / month (up to 10 people); Business $349 / month (up to 40 people); self-hosting $0', 'Per user, by Google Workspace plan'] },
    ],
    addsTitle: 'What Trina Drive adds for AI',
    adds: [
      { title: '“No AI” folders', body: 'Keep a folder from every AI, even for people who can open it.' },
      { title: 'Hidden means it doesn’t exist', body: 'A folder you can’t open never shows up for your AI. Not even its name.' },
      { title: 'Drafts, not edits', body: 'Through Trina Drive, AI writes drafts. A person decides where they go.' },
      { title: 'Every read on the record', body: 'Each file an AI opens is logged: which person, which app, which file.' },
    ],
    fitTitle: 'When Google Drive fits better',
    fit: [
      'Your team writes together in Docs, Sheets and Slides in real time. Trina Drive stores files; it is not a document editor.',
      'You don’t plan to let AI apps read your team’s files.',
    ],
    bothTitle: 'Or use both',
    both: 'Import files from Google Drive (beta): Docs, Sheets and Slides arrive as Word, Excel and PowerPoint.',
    pricing: 'See pricing',
    note: 'Based on public documentation as of October 2026. Something out of date? Write to us and we will fix it.',
    back: 'Back to home',
  },
  notFound: { title: 'Page not found', body: 'That page does not exist — or you are not allowed to see it.', back: 'Go home' },
}

export default en
export type Copy = typeof en
