## What and why

<!-- What does this change, and what problem does it solve? Link the issue: Fixes #123 -->

## Permissions, drafts and audit

<!-- Does this touch who can see or change what (src/policy.ts, src/rights.ts, tokens, OAuth, the web API)?
     If yes: which rule (docs/SECURITY-MODEL.md), and which test proves hidden stays hidden? Write "no" if it does not. -->

## How it was tested

- [ ] `bun run typecheck`
- [ ] `bun test` (isolated, the default)
- [ ] `TDRIVE_SHELL=inprocess bun test`
- [ ] `bun run build:web` (if `web/` changed), and checked in a browser
- [ ] new or changed behaviour has a test (security-relevant changes: in `test/security/`)

## Checklist

- [ ] no secrets, real customer data or personal file names in code, tests or screenshots
- [ ] docs updated (README, `docs/`) if behaviour, commands or settings changed
- [ ] names come from `src/brand.ts` (no hard-coded product, command or token names)
