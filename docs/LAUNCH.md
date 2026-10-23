# Launch kit (drafts)

Everything here is a **draft** for the public launch. Nothing has been posted.

## GitHub repository settings

- **Name:** `potenlab/trina-drive` (renamed by the coordinator, not in this branch).
- **Description (set 2026-10-23):** Your company folders, as your team's AI knowledge base. Ask Claude, ChatGPT, Codex
  or Cursor about your files: no uploads, each person's AI sees only what they may, through Trina Drive AI writes
  drafts (not originals), every read logged. Self-hosted.
- **Website:** https://drive.trina.app
- **Topics:** `mcp`, `ai-agents`, `claude-code`, `self-hosted`, `permissions`, `file-server`, `nas`, `rag`, `codex`
  (optional extras if there is room: `model-context-protocol`, `audit-log`, `cursor`, `hwp`). Set, plus `chatgpt`,
  `knowledge-base`, `document-search`.
- **Social preview image:** `docs/assets/social-preview.png` (1280×640). GitHub has no API for it: upload it by hand
  in Settings → General → Social preview.
- Enable: Issues, Discussions (Q&A, Ideas, Show and tell), private vulnerability reporting, Dependabot alerts (all on
  since 2026-10-23; welcome post: Discussions #1). Branch protection on `main`: CI must pass (not yet: CI is red on
  `main`, turn it on once it's green).

## Launch checklist

**Before (gate):**

- [ ] License announced and `LICENSE` added (AGPL-3.0 server planned); README and badge updated
- [ ] CLA/DCO decided; CONTRIBUTING updated; CLA bot installed if CLA
- [ ] Security gate passed (plan 7.4); SECURITY.md address `security@trina.app` receives mail
- [ ] `contact@trina.app` receives mail
- [ ] CI green on `main` (Ubuntu + macOS); badge shows passing
- [ ] Signed and notarized macOS release (Developer ID) on GitHub Releases with `.sha256`
- [ ] Docker image published (`ghcr.io/potenlab/trina-drive`), SBOM attached
- [x] `docs/assets/demo.gif` recorded (Mina in Sales vs Sam in Finance, real `tdrive sh` / MCP output, 23 s, 0.6 MB)
  and in both READMEs; how to re-record: `docs/assets/src/README.txt`
- [ ] drive.trina.app live with `#pricing`; README links checked
- [ ] Fresh-machine test: README quickstart from a clean clone, macOS installer on a clean Mac, Docker on a clean VM
- [ ] Comparison table re-checked against vendors' current docs (Box, Google Drive MCP, Glean, Dust, QNAP)
- [ ] Repo renamed, description, topics, social preview set; old `shelf` names gone (`git grep -i shelf`)
  (renamed, description and topics done; social preview still to upload by hand)

**Launch day (Tuesday–Thursday, 8–10 am US Eastern for HN):**

- [ ] Show HN post (one founder answers every comment for the first 6 hours)
- [ ] r/selfhosted post (the same day or the day after; not cross-posted to several subs at once)
- [ ] GeekNews (news.hada.io) 보여줘 post, Korean time morning
- [ ] X / LinkedIn / Threads short post with the GIF
- [ ] Watch issues; label `good first issue` for a handful of small tasks (10 starter issues #2–#11 filed, three of
  them `good first issue`)

**After (first two weeks):**

- [ ] Reply to every issue within a day; fix install friction first
- [ ] Write up what people asked for most; adjust the roadmap section
- [ ] Follow-up post: "What we learned letting AI agents into a NAS" (technical, with the threat model)

## Show HN

Title options (≤ 80 characters):

1. Show HN: Trina Drive – Give AI agents your company files, with per-person permissions
2. Show HN: Trina Drive – A self-hosted file server where AI agents see only what you can
3. Show HN: Trina Drive – An MCP shell over your NAS that respects who can read what
4. Show HN: Open-source team drive for Claude Code/Codex with permissions and audit

Text:

> Hi HN, we're the team behind Trina Drive (https://github.com/potenlab/trina-drive).
>
> We're a small team in Korea, and so are the offices around us. Everyone started using Claude Code and Codex, and
> the first thing they wanted was "let it read the shared drive". The options were: sync the whole NAS to every laptop (the agent sees everything,
> nobody knows what it read), move to a cloud drive with an MCP connector (no shell, agent controls only in the top
> tier), or give the AI one NAS account.
>
> Trina Drive is a small server you run next to your existing folders. Agents connect over MCP and get a real shell
> (`ls`, `grep -r`, pipes, built on just-bash) over a virtual tree that contains only what that person may read,
> narrowed further by the token. Hidden paths are indistinguishable from missing ones (same output, error and exit
> code). Originals are read-only; agents write to a draft box, and every draft remembers which folders it came from.
> Promoting a draft into a folder with more readers waits for a human passkey approval. Every call goes into a
> hash-chained audit log, with signed anchors sent off the server.
>
> It also greps inside PDF, Office and HWP (the Korean word processor format), with parsers running in sandboxed
> workers (sandbox-exec on macOS, bubblewrap on Linux).
>
> What it does not do: stop the AI provider from seeing what the agent read, or catch copies made outside it. The
> security model doc lists the known holes.
>
> Self-hosting is free with every feature; we make money by running it for teams who don't want to. It runs on a Mac
> mini or a Linux box with Docker. We'd love feedback on the permission model and on what breaks when you install it.

## r/selfhosted

Title: **Trina Drive: self-hosted file server that lets AI agents (Claude Code, Codex, ChatGPT) read your NAS, but only
what each person is allowed to**

> I've been building this for small offices that already have a NAS and now have half the team using AI coding agents.
>
> - Runs on your hardware: macOS installer (Mac mini) or Docker Compose on Linux. No cloud account.
> - Leaves your files where they are: point it at existing shares (mounted read-only).
> - Each person's agent sees only what that person may read; tokens can narrow it further (folders, read-only, expiry).
> - Agents get a shell (`ls`, `grep -r`, pipes) and can grep inside PDF, DOCX, XLSX and HWP.
> - Agents never write originals: they write drafts, and widening a draft needs a human with a passkey.
> - Hash-chained audit log, alerts for bulk reads and new clients, encrypted backups.
> - Web UI for people (English/Korean): folders, rules, tokens, approvals, read-only file browser.
>
> Free and self-hosted with all features; license announced before 1.0 (AGPL planned for the server).
> Repo: https://github.com/potenlab/trina-drive. Happy to answer questions about the threat model.

(Check the subreddit's self-promotion rules on the day; reply as the author, flair "Release".)

## GeekNews (긱뉴스) 보여줘

제목: **Show GN: Trina Drive - 사람마다 권한이 다른, AI 에이전트용 팀 파일 서버 (오픈소스, 설치형)**

> 사무실 NAS나 공유 폴더를 Claude Code, Codex, Cursor, claude.ai, ChatGPT에 연결해 주는 오픈소스 서버예요.
>
> 팀에서 AI 에이전트를 쓰기 시작하면 바로 "공유 드라이브 좀 읽게 해 줘"가 나와요. 그런데 지금 방법은 NAS 전체를 노트북마다
> 동기화하거나(에이전트가 다 보고, 뭘 읽었는지 아무도 모름), 클라우드 드라이브로 옮기거나, AI에게 NAS 계정 하나를 주는 것뿐이었어요.
>
> - 에이전트에게는 그 사람이 읽을 수 있는 파일만 보여요. 토큰마다 폴더·읽기 전용·만료로 더 좁힐 수 있어요.
> - 볼 수 없는 폴더는 없는 폴더와 출력·오류·종료 코드까지 똑같아요.
> - `ls`, `grep -r`, 파이프가 되는 셸이 있고, PDF·오피스·**HWP/HWPX** 본문까지 grep돼요.
> - 원본은 읽기 전용이에요. 에이전트는 초안함에만 쓰고, 초안에는 출처 폴더가 붙어요. 더 넓은 폴더로 올릴 때는 사람이 패스키로 승인해요.
> - 모든 호출이 해시 체인 감사 기록에 남고, 서명한 기준점을 서버 밖으로 보내요.
> - 맥 미니 설치기와 리눅스 Docker를 지원하고, 웹 화면은 한국어로 써요.
>
> 설치형은 모든 기능을 무료로 쓸 수 있고, 운영을 대신 맡기는 관리형 요금제가 따로 있어요.
> 저장소: https://github.com/potenlab/trina-drive · 소개: https://drive.trina.app
>
> 권한 모델이나 설치하다 막히는 부분에 대한 의견을 받고 싶어요.
