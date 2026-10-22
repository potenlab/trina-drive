# Landing page research — YC-style dev-tool / AI-infra sites (2026-10-23)

Looked at 13 live landing pages (fetched 2026-10-23; HTML via curl where the site serves agents a markdown index).
Goal: copy the *structure and restraint*, not the claims. We are **not** YC-backed, so no YC badge or "Backed by" band.

| Site | YC (public info; ? = not checked) | Hero (headline / subline) | CTAs | Proof band | Product visual | Notable |
|---|---|---|---|---|---|---|
| [resend.com](https://resend.com) | W23 | "Email for developers" / "The best way to reach humans instead of spam folders…" | Get started · Contact | customer logos | code sample with SDK language tabs (Node, Python, Go…) | language tabs = "works with your stack" in one widget |
| [trigger.dev](https://trigger.dev) | W23 | "Build and deploy durable AI agents and workflows" / "…the open source platform for building AI agents in TypeScript" | Start building now · Learn about AI agents · Copy setup prompt | "Works with your existing tech stack" logos + GitHub stars / Discord count | TypeScript code + "how it works" video | open source (Apache-2.0) + self-host link; closing CTA "Deploy your first agent today" |
| [browserbase.com](https://www.browserbase.com) | ? | "Give your agents access to the whole web." / "…as reliable and programmable as APIs" | Get API key · Try for free · Talk to sales | "10,000+ companies…" logos | illustration | 3-step "Zero setup" flow; SOC-2 mentioned inline in hero copy |
| [e2b.dev](https://e2b.dev) | ? | "The AI Agent Cloud" / "Secure, on-demand machines for AI agents…" | Start building · Docs | logos | terminal / sandbox UI | "Deployment and security" block: Firecracker, BYOC, SOC 2, open-source parts |
| [cal.com](https://cal.com) | ? (OSS) | "The better way to schedule your meetings" | Sign up with Google / email · Book a demo | "Trusted by fast-growing companies" + wall of love | product UI | 3-step "How it works"; FAQ (5 Q) with pricing and compliance answers |
| [supabase.com](https://supabase.com) | S20 | "Build in a weekend / Scale to millions" | Start your project · Request a demo | big logo wall | product UI tiles | open source + self-host stated in subline; "no vendor lock-in" |
| [infisical.com](https://infisical.com) | W23 | "Security infrastructure for developers and AI agents" | Get started · Talk to an expert | customer logos, "10B+ secrets/day" | dashboard | MIT core "free forever", paid = SSO/SCIM/audit streaming; FAQ covers self-hosting, compliance, AI-agent safety |
| [mintlify.com](https://www.mintlify.com) | W22 | "The documentation platform for agents" / "Self-updating documentation…" | Get started · Talk to sales | "Trusted by ambitious companies" logos; YC only as a *customer* stat further down | live counters | final CTA repeats the category line |
| [kernel.sh](https://www.kernel.sh) | S25 | "you build agents. we give them the internet." / "crazy fast, open source browser infra…" | start building · book demo | "loved by 11,000+ teams" logo row (YC logo is in the row) | — | SOC2 / HIPAA chips right under the H1; 6-up feature grid of one-liners |
| [agentmail.to](https://www.agentmail.to) | S25 | "Email for AI Agents" / "The email inbox API for AI agents" | Get started · Docs | "Backed by" row with investor names incl. Y Combinator link | code | "Why agents need their own inboxes" problem section before features |
| [agentops.ai](https://www.agentops.ai) | ? | "Trace, Debug, & Deploy Reliable AI Agents." | Start for Free · GitHub (stars) | framework logos "Powering thousands…" | `pip install agentops` one-liner | 3-tier pricing on the page ($0 / from $40 / Enterprise) |
| [linear.app](https://linear.app) | no | "The product development system for teams and agents" | Get started · Contact sales | logo strip *under* the screenshot | big product screenshot | "Fig 0.1" figure labels, hairline dividers, final CTA "Built for the future. Available today." |
| [letta.com](https://www.letta.com) | ? | "Machines that learn" | (research lab) | press quotes | `npm i -g …` install line | minimal footer: GitHub, Discord, X, Privacy, Terms |

Also used for context: YC S25 batch lists ([forrealai](https://forrealai.substack.com/p/whats-popping-in-yc-s25),
[TechCrunch W25 demo day](https://techcrunch.com/2025/03/13/10-startups-to-watch-from-y-combinators-w25-demo-day)).

## Patterns (what nearly all of them do)

1. **Hero = one plain-language line + one subline that names the category and the buyer.** Short (5–9 words). Sublines
   say *what it is* ("the open source platform for…", "the email inbox API for AI agents").
2. **Two CTAs**: one primary self-serve ("Get started", "Start building") + one human ("Book demo", "Talk to sales").
   Often a copyable one-liner (`pip install …`, "Copy setup prompt") as a third, quieter action.
3. **Proof directly under the hero**: logo strip / numbers / compliance chips. When a company has no logos yet it uses
   *capability proof*: "Works with your existing stack", GitHub stars, "open source", SOC2 chips.
   → For us: **"Works with Claude Code · Codex · Cursor"** chips + "Open source · Self-hosted · Free forever". No YC.
4. **Product visual is code or a terminal**, not stock art. Dev-tool sites show the thing working (Resend code tabs,
   Trigger code, AgentOps install line, E2B sandbox). → animated terminal: kim vs boss.
5. **Problem before features** (AgentMail "Why agents need their own inboxes", Browserbase "bridge" section).
6. **3–6 feature blocks**, each a noun-phrase title + one sentence; often a 2×3 grid with hairline borders (Kernel, Linear).
7. **"How it works" in 3 steps** (Cal.com, Browserbase).
8. **Security as its own block** for anything touching company data (E2B "Deployment and security", Infisical
   compliance + "AI agent safety" FAQ). Honest scoping beats badges we don't have.
9. **Pricing on the page** when it is simple (AgentOps, Cal.com FAQ); "free forever" self-host tier first (Infisical).
10. **FAQ** of 5–10 questions handling the buying objections (self-hosting, compliance, AI safety, pricing).
11. **Final CTA repeats the hero promise** in one line + the same two buttons.
12. **Minimal footer**: product links, GitHub, legal (Privacy, Terms), company line.

## Visual language

- White / near-black, one accent, lots of whitespace, 1px hairline borders and subtle grid backgrounds (Linear, Kernel,
  Resend). Monospace for anything technical. System or Inter/Geist-like sans. Dark mode respected.
- Little motion: one hero animation at most; everything else static.

## What we take / leave

- Take: hero + 2 CTAs + install line; capability-proof band; terminal demo as the product visual; problem → features
  grid → 3 steps → security → pricing → FAQ → final CTA → small footer.
- Leave: customer logos (none yet), compliance badges (none yet), "Backed by" (not YC), testimonials, live counters.
- Korean version: follow `~/.claude/skills/korean-landing-copy` — noun-phrase headings, 해요체 body (small offices,
  대표님이 직접 고르는 제품), no translated English section labels.
