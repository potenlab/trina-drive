# Contributing to Trina Drive

Thanks for helping. Trina Drive lets AI agents read a team's files under each person's permissions, so correctness
and security come before features. This page covers setup, tests, and what we look for in a pull request.

## Ground rules

- **Security issues go to security@trina.app, not to public issues.** See [SECURITY.md](SECURITY.md).
- Be kind; we follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- For anything larger than a bug fix, open an issue first so we can agree on the approach.
- **License and sign-off.** Trina Drive is licensed under [Apache-2.0](LICENSE), and contributions are accepted under
  the same license (Apache-2.0, section 5), with no separate agreement to sign. Sign off every commit with
  `git commit -s`, which adds `Signed-off-by: Your Name <you@example.com>` and certifies the
  [Developer Certificate of Origin](#developer-certificate-of-origin) below. Forgot? `git commit --amend -s` for
  the last commit, or `git rebase --signoff main` for all of them.

## Setup

Needs [Bun](https://bun.sh) 1.3, ripgrep and poppler (`brew install ripgrep poppler` on macOS; `ripgrep`,
`poppler-utils` and `bubblewrap` on Debian/Ubuntu).

```sh
bun install
bun run build:web                                  # the web app, served by `serve` at /
alias tdrive="bun run $PWD/src/cli.ts"
tdrive --data ./.trina-drive demo seed             # sample company, people, rules, tokens
tdrive --data ./.trina-drive serve                 # http://127.0.0.1:8787/ and /mcp
bun run dev:web                                    # optional: Vite dev server proxying to that serve
```

`./.trina-drive/` is ignored by git. Product names (Trina Drive, `trina-drive`, `tdrive`, `tdrive_pat_`, `TDRIVE_*`)
come from [`src/brand.ts`](src/brand.ts); never hard-code them.

## Tests

```sh
bun run typecheck                    # server and web (tsc --noEmit, twice)
bun test                             # everything (~4 min); shell commands run in sandboxed workers
TDRIVE_SHELL=inprocess bun test      # the same with just-bash in the server process (the hidden-path suites run both)
bun run test:fuzz                    # path/argument fuzzer, 60 s; --seconds N --seed S for long runs
scripts/docker-test.sh               # the Docker image end to end, then the suite inside it (Linux Docker host)
```

`TDRIVE_TEST_HWP=/path/to/real.hwp bun test` also checks a file saved by Hangul. Tests that need macOS (installer dry
run, vendored pdftotext) skip themselves elsewhere. CI runs typecheck, the web build and `bun test` on Ubuntu and macOS.

`test/security/` is the heart of the suite (threat model in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md)):

- `matrix`: every entrance (shell, read tool, grep, web, drafts) × role × case of the permission rules;
- `existence`: a hidden path answers byte for byte like a missing one (plus timing p50/p95, `TDRIVE_TIMING_RUNS`);
- `fuzz`: canaries in every forbidden file, hidden names, originals unchanged, no crash, no server paths;
- `resource`: shell attacks stay bounded, per-call read caps, draft quota, concurrent command limits;
- `mcp-protocol`, `oauth-matrix`, `links`, `tools`.

`test/extract-isolation.test.ts` feeds malicious documents (zip bombs, a parser that never returns, huge allocations)
and checks they die in their worker.

## What makes a good pull request

1. **One decision point.** Anything that reads files goes through `src/policy.ts` (agents) or `src/rights.ts`
   (admin-side decisions). Do not filter results after the fact: names outside a token's scope would leak.
2. **Hidden equals missing.** A path someone may not see must answer exactly like one that does not exist: same
   output, error text, exit code, HTTP status and body. Add a case to `test/security/existence.test.ts` or the matrix.
3. **Fail closed.** If the server cannot decide, it refuses.
4. **Everything is audited.** New tools and endpoints write an audit row; if the row cannot be written, nothing is
   returned or kept.
5. **No secrets in logs or audit rows.** New secret formats get a pattern in `src/redact.ts` and a test.
6. **Tests.** Every behaviour change has one; security-relevant ones live in `test/security/`.
7. **Docs.** Update the README or `docs/` when commands, settings or behaviour change.
8. **Small commits** with messages that say what changed and why.

Fill in the pull request template; it asks about permissions and audit for a reason.

## Code style

TypeScript, strict, ES modules, no build step for the server (Bun runs the sources). Keep dependencies few and
pinned (each one is reviewed for license and supply chain; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#dependencies-and-licenses)
and [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md): nothing GPL/AGPL-licensed may become a runtime dependency).
Comments explain why, not what. The web app is React + Vite with English and Korean strings in `web/src/i18n.ts` and
the `*-i18n.ts` files: add both languages.

## Developer Certificate of Origin

By signing off a commit you certify the following ([developercertificate.org](https://developercertificate.org)):

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
