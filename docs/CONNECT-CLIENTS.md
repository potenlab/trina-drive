# Connecting AI clients

`tdrive mcp add` connects Claude Code, Codex or Cursor on a person's own computer. For claude.ai and ChatGPT (OAuth,
v0.2) see [CONNECT-CLAUDE-AI.md](CONNECT-CLAUDE-AI.md) and [CONNECT-CHATGPT.md](CONNECT-CHATGPT.md).

```sh
tdrive mcp add claude --server http://files.office.lan:8787 --login kim
tdrive mcp add codex  --server http://files.office.lan:8787 --login kim --scope 공용,프로젝트 --read-only
tdrive mcp add cursor --server http://files.office.lan:8787 --login kim --dry-run   # show what it would write
```

`mcp add` runs on the person's own computer (it never opens a data directory). It signs in with the person's password
(`--password-stdin`, `$TDRIVE_PASSWORD`, or a no-echo prompt), makes a personal token on the server (`POST /api/tokens`:
default 7 days, all folders the person reads; `--scope 공용,프로젝트`, `--read-only`, `--ttl`; admins must pass `--scope`
or `--all-folders`, plan 5.1), signs out, and connects the client **in user scope only** — never a repo's `.mcp.json`,
`.cursor/mcp.json` or `.codex/`. `--token-stdin` takes an existing token instead, from a pipe or, when standard input is
a terminal, pasted at a prompt that does not echo it (a token argument is refused: shell history). `--dry-run` prints every command and file it would write, with `<token>` in place of the secret, and contacts
nothing.

The token is kept in the macOS login Keychain (`security -i` on stdin, so it never appears in a process list; service
`trina-drive-mcp`, account `<client>:<name>`), or with `--store file` (default off macOS) in `~/.config/trina-drive/tokens/<client>-<name>`
(0600). `--store inline` writes it into the client's file in clear text, with a warning (refused when that file is in a
git work tree, e.g. a dotfiles `$HOME`). Codex and Cursor read it from an environment variable that
`~/.config/trina-drive/env.sh` sets (on macOS each line reads the Keychain; no secret in the file): add
`. ~/.config/trina-drive/env.sh` to your shell profile once.

| client (checked 2026-10-23) | how it is written | where | token reference |
|---|---|---|---|
| Claude Code 2.1.308 | `claude mcp add-json --scope user trina-drive '{"type":"http","url":…,"headersHelper":…}'` (run in `$HOME`); without the CLI, `mcpServers.trina-drive` in `~/.claude.json` (`$CLAUDE_CONFIG_DIR` honoured) | user scope | `headersHelper`: a command Claude runs to get `{"Authorization":"Bearer …"}`, here `printf … "$(security find-generic-password … -w)"` |
| Codex 0.163.0 | `codex mcp add trina-drive --url …/mcp --bearer-token-env-var TDRIVE_TOKEN_CODEX`; without the CLI, `[mcp_servers.trina-drive]` in `~/.codex/config.toml` (`$CODEX_HOME` honoured) | user config | `bearer_token_env_var`. `--auto-approve` adds `default_tools_approval_mode = "approve"` (otherwise `codex exec`, approval policy "never", refuses every call of this server) |
| Cursor (cursor-agent 2026.09.18) | no `mcp add` command: `mcpServers.trina-drive` in `~/.cursor/mcp.json` | user scope | `"Authorization": "Bearer ${env:TDRIVE_TOKEN_CURSOR}"`; enable it in Settings → MCP or `cursor-agent mcp enable Trina Drive` / `--approve-mcps` |

Before writing, it reads that client's existing entries pointing at the same server (any name, Claude's local-scope
`projects.*` too) and warns (plan M8) when one holds a broader token (all folders where the new one is narrowed, or
drafts allowed where the new one is read-only — compared through `GET /api/tokens` by the token hint), when one keeps a
token in clear text, or when its token cannot be read. An entry with the same name is replaced only with `--force`.
Plain `http://` to a non-loopback address is warned about (password and token cross the network unencrypted).

Checked live with HOME set to a scratch directory: `claude mcp get trina-drive` → "✔ Connected" through the headersHelper
(and "✘ Failed to connect" with a wrong token), `codex mcp get trina-drive --json` shows the streamable HTTP transport with
`bearer_token_env_var`, and `cursor-agent mcp list-tools trina-drive` lists the five tools through `${env:…}`.

The web's My tokens page shows these commands per client (tabs: Claude Code, Codex, Cursor): the recommended
`mcp add <client> --server <its address> --login <you>`, and for a token just made there `mcp add <client> --server …
--token-stdin` (paste it at the hidden prompt). A manual client entry with the token in clear text is offered only
collapsed and labelled as such; the page never builds a command line that holds a token.

Revoke a token on the web (My tokens) when you stop using it; `claude mcp remove trina-drive -s user`,
`codex mcp remove trina-drive`, or delete the entry from `~/.cursor/mcp.json`, and the Keychain item
(`security delete-generic-password -s trina-drive-mcp -a <client>:trina-drive`).
