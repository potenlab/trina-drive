# Security policy

Trina Drive decides which files AI agents may read on behalf of each person. A bug that lets anyone see, change or
hide more than they should is a security bug, and we want to hear about it.

## Reporting a vulnerability

**Email security@trina.app.** Please do not open a public issue, pull request or discussion.

Include what you can:

- the version (first line of `tdrive`) or commit, and how it runs (macOS installer, Docker, from source);
- steps to reproduce, ideally with the `tdrive demo seed` sample data;
- what an attacker gains (for example: an agent token reads a file outside its person's rules, a hidden path can be
  told apart from a missing one, an audit row can be removed unnoticed).

Please do not test against installations you do not own, and do not access, change or keep other people's data.

## What to expect

| | |
|---|---|
| First response | within **72 hours** |
| Assessment and severity | within 7 days |
| Fix | as fast as severity requires; critical issues are prioritized over all other work |
| Disclosure | coordinated with you; we credit you in the release notes unless you prefer otherwise |

Security fixes are released to everyone at the same time, self-hosted and managed alike. We will not take legal
action against good-faith research that follows this policy.

## Scope

In scope: the server (`src/`), the web app (`web/`), the CLI including `tdrive mcp add`, the macOS installer
(`scripts/`), the Docker image and its security profiles (`Dockerfile`, `docker/`).

Known, documented limits are listed in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md#known-limits) (for example,
timing differences between hidden and missing paths are not equalized). Reports that show one of them is worse than
documented are welcome.

## Supported versions

Before 1.0, only the latest release receives security fixes.
