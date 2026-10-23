# Trina Cloud — hosted Trina Drive, one isolated instance per team

A team signs up, pays through Paddle, and gets its own Trina Drive at `https://<team>.cloud.trina.app` with a real
certificate, so Claude.ai and ChatGPT connectors (OAuth, v0.2) work right away. Each team runs the unchanged
`trina-drive` image in its own container, on its own network, with its own volume, uid, limits and keys.

```
cloud/
  control/   the control plane (Bun, no dependencies): sign-up, teams, Paddle webhook, jobs, drivers, admin CLI
  caddy/     Caddy with rate limiting: *.cloud.<domain> → the team's container, on-demand TLS, paused page
  dev/       local Trina Cloud on Docker (up.sh / down.sh) and the end-to-end test (e2e.ts)
  host/      EC2 bootstrap and the host agent the control plane drives over SSM
  infra/     Terraform for AWS (applied once, 2026-10-23: test deploy, now on hold)

  control/src/scaler.ts   the host scaler: team hosts start when a paid team needs one and go when empty
```

Status: **runs end to end locally** (four teams on simulated hosts, 179 checks), with every team in hosted mode (admins enrol a
second factor), behind Caddy as its one trusted proxy, on managed storage with the plan's quota, and sending its own
mail through the host's mail relay. The AWS path (driver, host agent, mail relay → Resend or SES, Terraform) is written and
unit-tested against fake AWS endpoints, and was **deployed once to AWS on 2026-10-23** (one control instance, one
m7g.xlarge host, the dogfood team `trina`): provisioning over SSM, hosted-mode settings, the host firewall, the mail
relay up to SES, backups to S3 and an export through KMS all worked; DNS delegation, TLS certificates and real mail wait
on the Gabia NS records and mail. AWS then denied SES production access: mail now goes through
[Resend](#mail-resend) from `drive.trina.app` (verified; not yet live on AWS: see
[Switching to Resend](#switching-a-deployment-to-resend)). The deployment is now in [hold mode](#hold-mode-no-teams-until-the-first-customer).
Team hosts [scale out from 0 and back in](#hosts-scale-out-and-scale-in) by themselves (built after that deploy: tested
locally and against fake AWS endpoints; needs a Terraform apply and a new control image, see the section).
See [Known gaps](#known-gaps-and-follow-ups) before launch.

## How it works

```mermaid
flowchart LR
  B["Buyer"] -->|sign up, pay| C["Control plane<br/>https://cloud.trina.app"]
  P["Paddle"] -->|signed webhook| C
  C -->|SSM Run Command<br/>(local: Docker CLI)| H
  C -->|A record per team| R[("Route 53<br/>cloud.trina.app")]
  C -->|setup link| M["Resend<br/>drive.trina.app"]
  subgraph H["Team host (EC2, Docker)"]
    K["Caddy<br/>on-demand TLS, rate limits<br/>.2 on every team network"] --> A["tdc-acme<br/>uid 20001 · own /28 network"]
    K --> G["tdc-globex<br/>uid 20002 · own /28 network"]
    A --- VA[("acme volume<br/>XFS quota")]
    G --- VG[("globex volume<br/>XFS quota")]
    A -.->|invites, resets| R["mail relay<br/>(host network, instance role)"]
    G -.-> R
  end
  R -->|team From only| M
  U["Claude.ai · ChatGPT · Claude Code"] -->|https://acme.cloud.trina.app/mcp| K
  H -->|encrypted backups| S3[("S3 · SSE-KMS")]
```

1. **Sign up** at `https://cloud.trina.app/signup` (email + password, argon2id). A confirmation link goes out by
   mail; only a confirmed account can create a team.
2. **Create a team**: name and address (`acme` → `https://acme.cloud.trina.app`; 3–32 characters, one DNS label,
   reserved names refused, never reused after deletion). Status `pending_payment`.
3. **Pay**: the dashboard opens Paddle checkout with `custom_data.tdcloud_team = <team id>`. Paddle calls
   `POST /paddle/webhook` (a second notification destination next to the website's `/api/paddle-webhook`).
   The control plane verifies the signature over the raw body (HMAC-SHA256, 5 s tolerance, secret rotation),
   de-duplicates by `event_id`, ignores out-of-order events by `occurred_at`, answers 200 at once and queues the work.
4. **Provision** (a job, retried with backoff, operator alerted after 5 failures): a ready host with room (none: the
   team waits in `provisioning` while the [scaler](#hosts-scale-out-and-scale-in) starts one), create
   the team's network, data directory/volume (XFS project quota on AWS), uid, `tdrive init` (prints the one-time setup
   token), `tdrive public enable --url https://acme.cloud.trina.app` (OAuth issuer and MCP resource for the
   connectors), `tdrive backup keygen --set`, the container, Caddy joined to the team network, health check, the
   team's DNS record. The team's network gets a fixed /28 and its env file the hosted-mode settings
   ([Per-team settings](#per-team-settings)).
5. **First admin**: the buyer gets a mail with `https://acme.cloud.trina.app/#token=<token>` (the setup page fills
   the token in and removes it from the address bar). Before anything else the admin enrols a passkey or an
   authenticator app (hosted mode). The token exists only in that mail and, hashed, inside the team's own database; the
   control plane never stores it. It works once, for 7 days; `teams resend-setup` issues a new one before setup is done.
6. **Use**: people sign in on the team's address; AI apps connect to `https://acme.cloud.trina.app/mcp` with OAuth
   (Claude.ai, ChatGPT) or a personal token (Claude Code, Codex, Cursor).

### Billing lifecycle

| Paddle subscription status | Team |
|---|---|
| `active` / `trialing` (first time) | provisioned |
| `past_due` | stays up for `TDCLOUD_PAST_DUE_GRACE_DAYS` (7), owner mailed; still unpaid → **suspended** (container stopped, paused page, nothing deleted) |
| `active` again | resumed |
| `paused` | suspended; `resumed` → resumed |
| `canceled` | up for `TDCLOUD_CANCELED_GRACE_DAYS` (3), then suspended; **`TDCLOUD_DELETE_AFTER_DAYS` (30) later: final backup (kept), then the instance and its data are deleted**. A new subscription in that window brings it back. |
| plan change (price id → `team`/`business`) | new cpu/memory/pids limits, disk cap and storage quota: the container is made again on the same data (a few seconds) |
| event for an unknown subscription (no `custom_data`) | operator alerted; `teams link <slug> <sub_id>` |

Paddle has no "deleted" event; "deleted" here is the end of the 30-day window after a cancellation.

### What each team gets

| | Team | Business |
|---|---|---|
| Files (the product's storage quota: files, trash, versions, uploads) | 100 GB | 1 TB |
| CPU / memory / processes | 1 vCPU / 2 GiB (no swap) / 512 | 2 vCPU / 4 GiB / 1024 |
| Disk cap (XFS: files + 20 GB database/drafts + one backup's staging) | 220 GB | 2,020 GB |
| Worker scratch (`/tmp` tmpfs) | 256 MB | 512 MB |
| Host capacity used | 1 slot | 2 slots |

Limits are in `control/src/plans.ts`. The plan comes from the Paddle price id (`PADDLE_PRICE_*`).

### Per-team settings

The control plane writes each team's env file (0600 locally, an SSM SecureString on AWS; `teamEnv` in
`control/src/cloud.ts`) before every (re)start of its container, so an upgrade or a plan change also brings new
settings to existing teams:

| | |
|---|---|
| `TDRIVE_HOSTED=1` | every admin enrols a passkey or an authenticator app before anything else (server-enforced) |
| `TDRIVE_TRUSTED_PROXY=<Caddy's address>/32` | X-Forwarded-For is believed from Caddy only ([Client addresses](#client-addresses)) |
| `TDRIVE_STORAGE=managed`, `TDRIVE_STORAGE_QUOTA=100GB` / `1000GB` | managed storage with the plan's quota |
| `TDRIVE_MAILER=ses`, `TDRIVE_MAIL_FROM`, `TDRIVE_SES_REGION`, `TDRIVE_SES_ENDPOINT=http://<gateway>:8025` | the team's own mail (invites, password resets, notifications) through the host's [mail relay](#mail-from-team-instances) |

Each team network is a fixed /28 out of `TDCLOUD_TEAM_SUBNETS` (default `10.128.0.0/11`, chosen by the team's
number, `control/src/teamnet.ts`): `.1` the gateway (the host: the mail relay), `.2` Caddy, `.3` the team, `.8–.15`
Docker's dynamic range. The network is labelled with Caddy's address so a host reboot joins Caddy again at the same
address (`host/bootstrap.sh`); the driver also moves Caddy back to it on every start, and an upgrade gives a network
made before fixed subnets its /28.

### Client addresses

Caddy is the only thing in front of a team and the only peer the team believes (`TDRIVE_TRUSTED_PROXY`). Caddy sets
`X-Forwarded-For` to exactly one value, the client's address (`header_up X-Forwarded-For {client_ip}` in
`caddy/team_routes.caddy`), whatever the client sent, and keys its own rate limits on the same `{client_ip}`. So the
product's per-address limits (sign-in, setup token, one-time links, MCP) and its audit and connection records see the
real client: the end-to-end test sends forged headers from two addresses and checks the team's rate-limit keys.

Today nothing sits in front of Caddy: DNS points at each host's Elastic IP, and `{client_ip}` is the TCP peer. If a
load balancer or CDN is ever added:

- **NLB (TCP passthrough)** keeps TLS, on-demand certificates and `strict_sni_host` at Caddy. Turn on proxy protocol
  v2 on the target group and add `listener_wrappers { proxy_protocol { allow <NLB subnets> } tls }` to Caddy's
  `servers` block: the peer is then the client again. Nothing else changes.
- **ALB or CloudFront** terminate TLS themselves (certificates move to ACM; Caddy's on-demand TLS and SNI check no
  longer apply). They append the address they saw to `X-Forwarded-For`. Put their ranges (the ALB's subnets; for
  CloudFront the `com.amazonaws.global.cloudfront.origin-facing` prefix list, and the ALB behind it) in Terraform's
  `front_proxies` (→ `TDCLOUD_FRONT_PROXIES` in Caddy's env). Caddy then reads `X-Forwarded-For` from the right
  (`trusted_proxies_strict`), skipping those ranges, and the first other address is the client's — an address a client
  wrote further left is never used. Caddy still hands the team one address, so the team's trusted proxy stays Caddy.
  Restrict the hosts' security group to those ranges, or anyone can reach Caddy directly and claim any address.

The control plane works the same way (`caddy/Caddyfile.control`; it reads the right-most entry, from 127.0.0.1 only).

### Mail from team instances

A team container cannot use the instance role: the metadata service is out of its reach on purpose (IMDSv2 hop limit
1 and the host firewall), because the host role can read every team's env parameter. Each host therefore runs a small
**mail relay** (`tdc-mail`, the control-plane image's `mail-relay` command, `control/src/relay.ts`) on the host
network. Teams send with the product's own SES mailer to `http://<their gateway>:8025`; the host firewall opens that
port to team bridges only. The relay accepts SES v2 `SendEmail` only from a team container's address (`.3` of a team
/28; not Caddy, not the host), with exactly one recipient, no Cc/Bcc, a plain subject and From = the team address
(`TDCLOUD_TEAM_MAIL_FROM`, `Trina Drive <drive@drive.trina.app>`; the display name may also be `<team> via Trina
Drive` — letters, digits, spaces and `. , & ' ( ) _ -`, at most 64 characters — anything else is refused), at most 60
per hour and 500 per day per team (`TDCLOUD_MAIL_RELAY_PER_HOUR` / `_PER_DAY`), and hands it to its upstream
(`TDCLOUD_MAIL_UPSTREAM`): **`resend`** (the default on AWS, [below](#mail-resend)), `ses` (signed with the instance
role; the host role's IAM allows `ses:SendEmail` only with `ses:FromAddress` = the team address, `iam.tf`, `TeamMail`),
`smtp`, or `outbox:<file>` (development). The `AWS_*` values in a team's env file are placeholders the product needs to
sign at all, not credentials. Locally the relay writes to `dev/.state/team-mail.log` instead.

### Mail (Resend)

AWS denied SES production access, so mail leaves through **Resend** (`control/src/resend.ts`): its HTTPS API,
`POST https://api.resend.com/emails` with a Bearer key — hosts and the control instance allow HTTPS out, and a
**sending-only key** is all it needs (nothing else is called at runtime).

- **Sender domain `drive.trina.app`**, verified in Resend (region Tokyo, `ap-northeast-1`). Its DNS is at Cloudflare
  (the trina.app zone), not in this Terraform: DKIM TXT `resend._domainkey.drive`, MX and SPF TXT on `send.drive`
  (bounces), plus DMARC `_dmarc.drive`. `cloud/scripts/resend-domain.ts` prints them and checks public DNS without any
  API call (`--records` reads the exact values with a full-access key; `--route53` exists for a domain in a Route 53
  zone). Teams send as `Trina Drive <drive@drive.trina.app>`, the control plane (confirmations, setup links, billing
  notices, ops alerts) as `Trina Cloud <cloud@drive.trina.app>` (`resend_domain` in Terraform).
- **The key** lives in two SSM SecureStrings (KMS `alias/tdcloud`): `/tdcloud/control/resend-api-key` for the control
  plane, `/tdcloud/hosts/resend-api-key` for the hosts' relays. Each role may read exactly its own parameter
  (`iam.tf`, `MailKey`). The process reads it itself, with the instance role, when mail goes out (cached 10 minutes,
  read again after a 401/403, so a rotated key needs no restart): it is never on a command line, in an env file, in
  `docker inspect` or in a log line, and errors are redacted. On a laptop: `~/.config/trina-drive/resend-api-key`
  (must be 0600; `TDCLOUD_RESEND_API_KEY_FILE`).
- **Sending**: one `Idempotency-Key` per message, so a retry after a lost answer cannot send twice; 429 waits for
  `Retry-After`, 5xx and network errors back off (0.5 s, 1 s, 2 s), within 12 s on the relay (the team's mailer gives
  up after 15 s) and 30 s for the control plane; other 4xx are not retried. Messages carry Resend tags
  `source=team|control` and `team=<number>` for the Resend log.
- **SES stays available** (`mail_upstream = "ses"` in Terraform, `TDCLOUD_MAILER=ses`, `TDCLOUD_MAIL_UPSTREAM=ses`):
  the identity, DKIM records and IAM statements are kept. `smtp` (default: Resend's SMTP `smtp.resend.com:465`, user
  `resend`, the same key as password) is there for a network that blocks the API.

## Security

Per team container (`control/src/drivers/docker.ts`; checked by `dev/e2e.ts`):

- **Own uid** (20000 + team number), owning only its data directory; the image's default uid 10001 is not used.
- **Hosted mode**: admins cannot use anything before they enrol a passkey or an authenticator app.
- **Read-only root**, `cap-drop ALL`, `no-new-privileges`, the bwrap seccomp profile and AppArmor profile from
  `docker/` and `systempaths=unconfined` — exactly the settings of `docker-compose.yml`, with their trade-offs
  ([docs/DOCKER.md §6](../docs/DOCKER.md)). The document and shell workers stay sandboxed (`worker isolation: bwrap`).
- **No published ports and no Docker socket**. Only Caddy reaches the container, over the team's own bridge network;
  Docker isolates bridges from each other. On AWS hosts a firewall (`host/bootstrap.sh`) also keeps team containers
  off the metadata service (and IMDSv2 hop limit 1), the VPC, other private ranges and the host itself (except the
  mail relay's port on their own gateway).
- **Limits**: cpu, memory (= memory+swap), pids, tmpfs size; disk by XFS project quota on AWS hosts (measured and
  flagged by the metrics loop everywhere). Logs capped at 3 × 10 MB.
- **Secrets**: the team env file is 0600 (local) or an SSM SecureString fetched into a root-only 0600 file (AWS); it is
  never on a command line. Outputs that carry secrets (setup token, backup key) come back from SSM sealed to a
  one-time key held only by the control plane, so SSM command history holds ciphertext.

At the edge (Caddy, `caddy/`): certificates only for names the control plane confirms (`ask`), `strict_sni_host`
(the Host header must match the TLS name), HSTS, request bodies ≤ 25 MB, per-client-address rate limits (sign-in,
setup and OAuth token endpoints 30/min, `/mcp` 300/min, everything 1200/min), `X-Forwarded-For` replaced by the
client's address, `/health` not exposed, a paused page when a team is stopped.

Control plane: argon2id passwords, email confirmation, sessions stored as hashes, CSRF token + Origin check on every
state change, rate limits per address and per account, no account enumeration on sign-up, security headers (CSP),
Paddle signature + timestamp + de-duplication (+ optional Paddle IP allowlist), each team's backup keys wrapped with
KMS (encryption context = the team), and a hash-chained **audit log** of every control-plane action
(`audit verify`): sign-ups, teams, billing transitions, provisioning, setup links sent, suspend/resume, backups,
exports, upgrades, deletions, admin CLI use (actor `admin:<user>`).

### Backups

Daily per team (`TDCLOUD_BACKUP_EVERY_HOURS`, newest `TDCLOUD_BACKUP_KEEP` kept), two objects:

- the product's own archive (`tdrive backup run`): a consistent copy of the database and drafts, encrypted to the
  team's product backup key ([docs/BACKUP-FORMAT.md](../docs/BACKUP-FORMAT.md));
- everything else on the volume (uploaded files, folders), tar'd and **sealed** to the team's own X25519 key
  (`control/src/seal.ts`: HKDF-SHA256 → AES-256-GCM in 1 MiB records, truncation detected).

Hosts only ever see public keys. Both secret keys are stored wrapped by KMS in the control database. On AWS the host
uploads straight to the backup bucket (versioned, SSE-KMS, public access blocked, TLS only). `teams export <slug>
--out DIR` produces the customer hand-over: `files.tar` (decrypted), the product archive and its key, a README.

## Run it locally

Needs Docker (colima works; on an AppArmor host `up.sh` loads the bwrap profile, through `colima ssh` on a Mac) and Bun.

```sh
cloud/dev/up.sh          # builds trina-drive:cloud-dev, tdcloud-control:dev, tdcloud-caddy:dev if missing,
                         # starts the control plane + Caddy, provisions acme and globex, runs the checks
cloud/dev/up.sh --no-teams
bun cloud/dev/e2e.ts     # the checks again (needs a fresh start for the sign-ups: run up.sh)
cloud/dev/down.sh        # removes every tdcloud container, network, volume and cloud/dev/.state
```

- Control plane: `https://cloud.localhost:8443` (mail lands in `cloud/dev/.state/outbox.log`)
- Teams: `https://acme.cloud.localhost:8443`, `https://globex.cloud.localhost:8443` (admin `alex`, password
  `admin-<slug>-password`, second factor: add `cloud/dev/.state/admin-<slug>.otpauth` to an authenticator app);
  TLS root: `cloud/dev/.state/caddy-root.crt`
- Team mail (invites, resets) through the relay `tdc-mail`: `cloud/dev/.state/team-mail.log`
- Admin CLI: `docker exec tdc-control bun /app/src/main.ts teams list` (all commands: `… help`)
- Hosts: simulated by the local driver (`LocalPool`: names `local-1`, `local-2`, … all on this engine, a 3 s "boot",
  one team per host, at most three, an emptied host goes after 20 s; `dev/compose.yml`), so scale-out from 0 and
  scale-in run here as on AWS: `docker exec tdc-control bun /app/src/main.ts hosts list`

What `e2e.ts` checks, over HTTPS through Caddy: two buyers sign up and confirm their email from the outbox, create
teams, a signed `subscription.created` provisions each (an unsigned one is refused, a replay is a no-op), the mailed
setup link creates the admin and works only once, the token is not in the control database; **hosted mode**: the admin
cannot make a token before enrolling, enrols an authenticator app with codes the test computes (RFC 6238) and signs in
again with the next code; the admin makes a personal token on the web; **an invite to dana goes from the team through
the relay into the dev mail sink with the team From, its link sets her password once**; MCP `initialize` /
`tools/list` and OAuth metadata (issuer = the team's URL) answer, an unauthenticated `/mcp` gets 401 pointing at the
metadata; **kim cannot see 경영 and boss can, in each team; every
token and session of one team gets 401 on the other; the acme container cannot reach globex or the control plane
on the network**; each container's uid, read-only root, capabilities, limits, networks, absence of ports and Docker
socket, and `worker isolation: bwrap`; **acme's network is a fixed /28 with Caddy at .2 and the team at .3, its env
has hosted mode, the trusted proxy, managed storage at 100 GB and SES through the relay; requests with forged
`X-Forwarded-For` from this machine and from a second address (a container at 10.250.250.50) are recorded — in the
connection list and the setup rate-limit keys — under the two real addresses, never a forged one or Caddy's; the
relay refuses another From and a sender that is not a team container**; no certificate for an unknown name; Host/SNI mismatch refused (421);
suspend → paused page → resume; backup (no plaintext in the object), export (decrypts), upgrade (data and tokens
survive, same address and env); the audit chain verifies and has every action; **hosts**: no host before the first
team, each team waits in `provisioning` until a host was launched and finished booting for it, a third team takes the
last host, a fourth waits at the limit (ops alerted, no setup mail yet), takes the host the third leaves when it is
deleted, and once it is deleted too that emptied host is scaled in after the grace period while the hosts of acme and
of the suspended globex stay. Last run: **179/179 passed in 199 s** (most of it waiting for hosts and grace periods).

Unit tests (`cd cloud/control && bun test`, 56 tests): the host scaler with a fake pool (scale-out from 0 with the team
waiting and the ready mail last, concurrent sign-ups and a second process, Business slots, the host limit, failed
bootstraps replaced and the stop after three, spare slots, scale-in only of hosts no team names — suspended and failed
teams keep theirs — and never of a host that holds unknown data or does not answer, a draining host, a lost host),
Auto Scaling / EC2 request shapes against fake endpoints; the billing state machine with a fake driver (grace,
suspend, resume, cancel → final backup → delete, resubscription, stale and foreign events, failed provisioning),
sealing (tampering, truncation), the AWS SigV4 test vector, sealed SSM outputs, Route 53/KMS request shapes, the
docker arguments of a team container; team network addresses, the team env (the product's own `mailEnv` accepts it),
the relay's checks and limits, the product's `SesMailer` through the relay to a fake SES signed with the host role,
mail through Resend against a fake Resend endpoint (request shape, idempotency key, 429/5xx retries within the deadline,
no retry on other 4xx, the key from SSM or a 0600 file and redacted everywhere, the relay forwarding a team's mail and
refusing disallowed mail before Resend, the "<team> via" From, the control plane's mailer), the SMTP upstream against
a fake SMTP server, the `resend-domain` script (no API call by default, a sending-only key, Route 53 dry run), a
plan change rewriting env + quota, a pre-fixed-subnet network made again, Caddy moved back to its address,
X-Forwarded-For read from the right in the control plane. They also run in the repository's `bun test`.

## Deploy to AWS — the owner's steps

First run on 2026-10-23 (the fixes it needed are in this text and in Terraform). Everything is in Seoul
(`ap-northeast-2`) by default; resources are prefixed `tdcloud`.

**0. Account and tools.** Pick the AWS account (a dedicated account in an AWS Organization is best: billing and
blast radius stay separate). Install Terraform ≥ 1.6, AWS CLI v2, Docker with buildx. `export AWS_PROFILE=<that
profile> AWS_REGION=ap-northeast-2`. The deploy identity needs EC2 (incl. Auto Scaling), S3, SSM, Route 53, ECR, SES,
KMS, CloudWatch Logs and IAM on `tdcloud*` roles/instance profiles/policies. Two things a least-privilege identity
(like `tdcloud-deploy`) runs into:

- **No `kms:PutKeyPolicy` in IAM**: KMS refuses a key policy that would lock its creator out. Put the identity in
  `kms_admin_arns` (it becomes a key administrator in the key policy).
- **No `iam:TagRole`**: creating `AWSServiceRoleForAutoScaling` works but tagging it (provider default tags) fails.
  Create it once (`aws iam create-service-linked-role --aws-service-name autoscaling.amazonaws.com`, or let the
  first apply do it), then set `create_autoscaling_service_linked_role = false`.

**1. Registries, key, buckets, DNS zone, SES identity** (first, partial apply). Keep state and variables outside the
repository:

```sh
S=~/.config/trina-drive/tdcloud-tf; mkdir -p $S && chmod 700 $S
cp cloud/infra/terraform/terraform.tfvars.example $S/terraform.tfvars     # domain, host count, image tags, …
cd cloud/infra/terraform
export TF_DATA_DIR=$S/.terraform
terraform init -backend-config="path=$S/terraform.tfstate"
terraform apply -var-file=$S/terraform.tfvars -target=aws_ecr_repository.repo -target=aws_ecr_lifecycle_policy.keep \
  -target=aws_kms_alias.main -target=aws_s3_object.artifacts -target=aws_route53_zone.cloud \
  -target=aws_sesv2_email_identity.mail -target=aws_route53_record.dkim -target=aws_route53_record.dmarc
terraform output name_servers
```

The SES identity is the cloud domain itself (`mail_domain` empty = `domain`); its three DKIM CNAMEs and a DMARC record
go into the Route 53 zone. It is kept for `mail_upstream = "ses"`; by default mail goes through Resend from
`drive.trina.app` (step 3).

**2. Gabia (trina.app DNS), once.** In 가비아 → DNS 관리 → trina.app → 레코드 수정, add **four NS records** with host
`cloud`, one per value of `name_servers` (e.g. `cloud  NS  ns-123.awsdns-15.com.`). Nothing else changes at Gabia
(not the apex, not `drive`). Check: `dig NS cloud.trina.app +short` shows the four Route 53 servers. The SES identity
`cloud.trina.app` then verifies itself within the hour (`aws sesv2 get-email-identity --email-identity cloud.trina.app`).

**3. Mail (Resend).** In Resend: add the domain `drive.trina.app` (region Tokyo), put the records its dashboard shows
into Cloudflare (trina.app zone, "DNS only"), wait for "Verified" (done on 2026-10-23), and create a **sending-only**
API key for that domain. Check DNS any time with `bun cloud/scripts/resend-domain.ts` (no API call). Put the key into
SSM from the 0600 file (`file://` keeps it off the command line and out of the shell history):

```sh
for p in /tdcloud/control/resend-api-key /tdcloud/hosts/resend-api-key; do
  aws ssm put-parameter --type SecureString --key-id alias/tdcloud --overwrite --name $p \
    --value file://$HOME/.config/trina-drive/resend-api-key
done
```

(Two Resend keys, one per parameter, let you revoke the hosts' key alone.) `team_mail_address` changes the teams'
address. With `mail_upstream = "ses"` instead: request SES production access
(`aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL …`, refused for this account on
2026-10-23) and the roles may send only from their own address (`ses:FromAddress`).

**4. Images** (arm64; tags are immutable, so give every build a new tag, e.g. version + commit):

```sh
REG=$(aws sts get-caller-identity --query Account --output text).dkr.ecr.ap-northeast-2.amazonaws.com
aws ecr get-login-password | docker login --username AWS --password-stdin $REG
V=$(git rev-parse --short HEAD)
docker buildx build --platform linux/arm64 -t $REG/trina-drive:0.2.0-$V --push .
docker buildx build --platform linux/arm64 -t $REG/tdcloud-control:0.1.0-$V --push cloud/control
docker buildx build --platform linux/arm64 -t $REG/tdcloud-caddy:2.10.2-1 --push cloud/caddy
```

and set `trina_image_tag` / `control_image_tag` / `caddy_image_tag` in `terraform.tfvars`.

**5. Paddle** (sandbox first, then live). Developer tools → Notifications → **New destination**
`https://cloud.trina.app/paddle/webhook`, events: `subscription.created`, `.activated`, `.trialing`, `.updated`,
`.past_due`, `.paused`, `.resumed`, `.canceled`, `transaction.completed`, `transaction.payment_failed`; copy its
**secret**. Keep the website's destination as it is. Checkout → **Website approval**: add `cloud.trina.app`. Note the
client-side token and the four USD price ids (Team/Business × monthly/yearly). The landing page's hosted-plan button
should link to `https://cloud.trina.app/signup` (a checkout started on the landing carries no team and is reported
to ops as "unlinked"; `teams link` fixes one by hand).

**6. Secrets** (SSM SecureStrings; they never pass through Terraform state):

```sh
aws ssm put-parameter --type SecureString --key-id alias/tdcloud --name /tdcloud/caddy-ask-key \
  --value "$(openssl rand -hex 32)"
terraform output -raw control_env_template > control.env    # fill in the <…> lines (ask key, Paddle values);
                                                             # mail: TDCLOUD_MAILER=resend + the key's parameter name
# Paddle not ready yet? A random PADDLE_WEBHOOK_SECRET placeholder and no price ids: the control plane starts, nothing
# can be bought, operator-made teams (`teams create`) work
aws ssm put-parameter --type SecureString --key-id alias/tdcloud --name /tdcloud/control/env --value file://control.env
rm -P control.env
```

**7. Everything else:** `terraform apply -var-file=$S/terraform.tfvars` (control instance + Elastic IP +
`cloud.trina.app` A record, the host ASG at 0: hosts start with the first team). First boot takes ~3 minutes
(`/var/log/tdcloud-bootstrap.log` on the instance; it ends with `tdcloud bootstrap done (host|control)`). On a host,
`iptables -S TDCLOUD-INPUT` must list the relay rule (the bootstrap stops if the isolation rules are missing).

**8. Check.** `curl https://cloud.trina.app/healthz` → `{"ok":true}`. Operator shell (no SSH anywhere):
`aws ssm start-session --target <control instance id>`, then
`sudo docker exec tdc-control bun /app/src/main.ts teams list`. Our own team, without payment:
`sudo docker exec tdc-control bun /app/src/main.ts teams create trina --owner contact@trina.app --name Trina
--allow-reserved` (the running control plane provisions it in about a minute; the setup link goes to the owner). Buy the Team plan in **sandbox** with a test card:
the setup mail arrives, `https://<slug>.cloud.trina.app` has a certificate, Claude.ai → Settings → Connectors → Add
custom connector → `https://<slug>.cloud.trina.app/mcp` connects. Then put the live Paddle values in
`/tdcloud/control/env` and rerun `sudo /usr/local/sbin/tdcloud-bootstrap` on the control instance.

**Operations.** Image tags live in each instance's `/etc/tdcloud/host.conf` (written once from user data; Terraform
ignores later user-data changes on the control instance, and a new launch template version only reaches new hosts).
To roll a new control-plane image to running instances: push it, set `TDCLOUD_HELPER_IMAGE` in `/tdcloud/control/env`,
then on the control instance and on every host (SSM Run Command or a session, as root):

```sh
sed -i 's#tdcloud-control:[^ ]*#tdcloud-control:<new tag>#' /etc/tdcloud/host.conf
. /etc/tdcloud/host.conf
aws s3 cp s3://$ARTIFACTS_BUCKET/host/bootstrap.sh /usr/local/sbin/tdcloud-bootstrap   # s3 cp drops the x bit
chmod 0755 /usr/local/sbin/tdcloud-bootstrap && /usr/local/sbin/tdcloud-bootstrap
```

(the control container and the hosts' mail relay `tdc-mail` restart from the new image; team containers keep
running). Changed host scripts reach the artifacts bucket with `terraform apply -target=aws_s3_object.artifacts`.
Capacity is the scaler's ([Hosts](#hosts-scale-out-and-scale-in)); a higher ceiling: `host_max` in Terraform and
`TDCLOUD_MAX_HOSTS` in `/tdcloud/control/env` (and the vCPU quota). Product upgrade: push a new `trina-drive` tag, set `TDCLOUD_IMAGE` in
`/tdcloud/control/env`, rerun the control bootstrap, then `teams upgrade --all` (each team: backup, new container on
the same data). Backups of the control database: nightly to `s3://<backup bucket>/control/`.

#### Switching a deployment to Resend

For the deployment on hold since 2026-10-23 (made with SES): (1) the key into SSM (step 3); (2) a new control image
(step 4) and `control_image_tag`, then `terraform apply -var-file=$S/terraform.tfvars` — the defaults
`mail_upstream = "resend"`, `resend_domain = "drive.trina.app"` add the `MailKey` IAM statements, a launch template
whose `host.conf` has `MAIL_UPSTREAM` / `MAIL_KEY_PARAM` and the team From `drive@drive.trina.app`, and the new
bootstrap in the artifacts bucket; (3) in `/tdcloud/control/env` (get it into a 0600 file, edit, put it back,
`rm -P` the file) set

```
TDCLOUD_MAILER=resend
TDCLOUD_RESEND_API_KEY_PARAM=/tdcloud/control/resend-api-key
TDCLOUD_MAIL_FROM=Trina Cloud <cloud@drive.trina.app>
TDCLOUD_TEAM_MAIL_FROM=Trina Drive <drive@drive.trina.app>
TDCLOUD_HELPER_IMAGE=<the new control image>
```

(4) start the control instance and roll the new image there as above (`host.conf` tag, fresh bootstrap); (5) hosts the
scaler launches from now on run the relay with Resend. A host that is already running needs `MAIL_UPSTREAM=resend`,
`MAIL_KEY_PARAM=/tdcloud/hosts/resend-api-key` and the new `TEAM_MAIL_FROM` in its `host.conf` and a bootstrap rerun,
and existing teams `teams upgrade` (their env carries the old From, which the relay now refuses). Check: sign up (or
`teams resend-setup <slug>`) and the mail arrives; `docker logs tdc-mail` on a host shows `(resend <id>)` lines;
`/healthz` of the relay (from the host: `curl 127.0.0.1:8025/healthz`) says `"upstream":"resend"`.

**Restore a team** (manual for now): on a host, recreate the team (`teams retry` on a fresh slug or the same one
after `destroy`), then `tdrive backup restore <archive> --into …` with the product key and `tar -x` of `files.tar`
from `teams export`; see [docs/DOCKER.md §5](../docs/DOCKER.md).

### TLS: on-demand (default) or one wildcard certificate

- **On-demand (default, `caddy/Caddyfile`)**: each host's Caddy gets a Let's Encrypt certificate per team name on
  the first TLS handshake (HTTP-01/TLS-ALPN-01; the team's A record points at its host), only after the control plane
  answers `ask` with 200 for that name. Nothing to configure. Limit: Let's Encrypt issues at most **50 new
  certificates per registered domain (trina.app) per week** (renewals excluded) — fine until sign-ups approach ~40
  teams a week.
- **Wildcard (DNS-01 on Route 53)**: one `*.cloud.trina.app` certificate per host; no per-team issuance, no rate
  limit concern. The Caddy image already includes `caddy-dns/route53`. Change the site block in `caddy/Caddyfile` to
  `tls { dns route53 }` (drop `on_demand`), and give the host role
  `route53:ChangeResourceRecordSets` on the zone limited to `_acme-challenge.cloud.trina.app` TXT records
  (condition `route53:ChangeResourceRecordSetsNormalizedRecordNames`), plus `route53:GetChange` and
  `route53:ListResourceRecordSets`. Unknown names then get a valid certificate and the paused page instead of a TLS
  error.

Either way the DNS zone is the delegated `cloud.trina.app` on Route 53; trina.app itself stays at Gabia.

### Hold mode (no teams until the first customer)

Everything that is slow to recreate or that DNS points at stays; everything that costs per hour goes. Since 2026-10-23
the deployment is in this state:

| Kept | Gone |
|---|---|
| Route 53 zone `cloud.trina.app` (+ `cloud.trina.app` A, DKIM, DMARC, CAA), SES identity, KMS key, ECR images, S3 buckets (team backups, control DB copy), VPC, IAM roles, launch template, SSM parameters `/tdcloud/control/env` and `/tdcloud/caddy-ask-key` | team hosts (ASG at 0, their Elastic IPs released, data volumes deleted), the test team's container, network, data and env parameter, its DNS record |
| control instance **stopped** (its root volume and Elastic IP kept, so `cloud.trina.app` stays put) | |

Going on hold was done by hand on 2026-10-23 (before the scaler existed: `host_count = 0` and `terraform apply`). With
the scaler it is shorter — the hosts go by themselves once no team names them:

```sh
# 1. each team: a last backup, then deleted (its host is scaled in TDCLOUD_EMPTY_HOST_GRACE later, volume and address
#    included). A team kept as `suspended` keeps its host: suspended teams count as occupying (their data is there).
docker exec tdc-control bun /app/src/main.ts teams backup <slug>; … teams delete <slug> --yes
docker exec tdc-control bun /app/src/main.ts hosts list          # wait for the hosts to show `gone`
# 2. a copy of the control DB in S3 (the nightly cron does not run while it is stopped)
# 3. the control instance (nothing can sign up or pay yet: Paddle is not wired, mail not switched to Resend yet)
aws ec2 stop-instances --instance-ids <control instance id>
```

Coming back: `aws ec2 start-instances --instance-ids <control>` (its containers restart by themselves; Caddy gets
the `cloud.trina.app` certificate once Gabia delegates the zone). Nothing else: the first paid team (or `teams
create`) launches a host, which boots in ~3 minutes with an Elastic IP the control plane allocated for it. A team kept
from before the hold (the dogfood `trina`) is restored by hand onto a host: `teams export` gives the archive and keys;
there is no `teams restore` yet, and its row still names the terminated host (the scaler ignores a host that is not in
the group; `hosts list` does not show it).

### Hosts: scale-out and scale-in

The control plane owns the number of team hosts (`control/src/scaler.ts`, the AWS side in `control/src/drivers/aws.ts`
`AwsPool`); Terraform only sets the bounds (ASG min 0, max `host_max`, `ignore_changes = [desired_capacity]`). With no
paying team there is no host.

- **Scale-out.** A paid team that finds no ready host with room stays in `provisioning` (the dashboard says "a server
  is being prepared for it") and its provision job comes back every 5–30 s without using up its five attempts. The
  scaler — one pass a minute (`TDCLOUD_SCALER_EVERY`), every 5 s while a team waits or a host boots — places the
  waiting teams on free slots (ready hosts, hosts still booting, launches the group has not started yet) and raises
  the group's desired count by the hosts still missing, up to min(`TDCLOUD_MAX_HOSTS`, the group's max). Just before,
  it allocates one Elastic IP per host to come (tag `tdcloud:pool=hosts`), which the host takes at boot. A new host is
  `booting` until `tdcloud-host info` (over SSM, every 15 s) reports its bootstrap done — `/etc/tdcloud/ready`, the
  bootstrap's last step, after the firewall, the data volume, the address, Caddy and the mail relay. Only then is the
  team provisioned on it, and only then does its owner get the "ready" mail with the setup link: from 0 hosts about
  4–5 minutes after payment. Teams go on the fullest host that still fits, so other hosts empty out.
- **Concurrent sign-ups.** Hosts still booting and launches not started count as capacity, and passes never overlap
  (chained in the process, and a lease in the control database keeps a second process out), so teams paying at the
  same moment launch only the hosts they need — twenty Team-plan teams, one host. Placing a team on a host is one
  database transaction.
- **The limit.** No room and no more hosts allowed: the team keeps waiting (it never turns `failed`); ops get "host
  limit reached" once per episode, and "team X has waited 15 min" (`TDCLOUD_HOST_WAIT_ALERT`). It starts as soon as a
  slot frees up or the limit is raised.
- **A host that does not boot** within `TDCLOUD_HOST_BOOT_TIMEOUT` (15 min) is terminated (with decrement, its volume
  deleted) and the same pass launches another if a team still needs it; ops hear each time. Three in a row stop
  scale-out (alert; fix it, then `hosts resume`). A host that finds no free pool address in 5 minutes stops its
  bootstrap on purpose (team DNS records must point at a stable address).
- **Scale-in.** A ready host that no team row names for `TDCLOUD_EMPTY_HOST_GRACE` (6 h) — suspended, failed and
  half-made teams name theirs (their data is there), only deleted ones do not — is marked `draining` in the same
  transaction that checks the team rows (from then on no team can be placed on it), asked over SSM for team directories
  and team containers (it must answer, with none: an unreachable host is kept for now, one with unknown team data is
  marked keep and ops alerted), then its scale-in protection comes off and it is terminated through the group with
  `TerminateInstanceInAutoScalingGroup` and `ShouldDecrementDesiredCapacity`. Once it is gone its data volume is
  deleted and its Elastic IP released. Never while a team waits, one host per pass, never below the spare slots,
  never a host marked with `hosts keep`; min 0.
- **Spare slots.** `TDCLOUD_SPARE_SLOTS=N` keeps N free slots ready (launched ahead, empty hosts kept) so that sign-ups
  do not wait for a boot; 20 = one warm host (~$180/month). Default 0.
- **A host that leaves otherwise** (the group replacing a host that failed its EC2 health check, a terminate by hand)
  while teams name it becomes `lost` and ops are alerted; its data volume is kept (restore by hand).

```
$ docker exec tdc-control bun /app/src/main.ts hosts list
pool       aws tdcloud-hosts: desired 2, running 2, max 3 (TDCLOUD_MAX_HOSTS 3, pool max 3)
per host   20 slots (Team 1, Business 2); spare slots 0; empty hosts go after 6.0h; boot timeout 15m
waiting    -

HOST                  STATE       SLOTS   FREE  EMPTY SINCE                  IP               TEAMS / NOTE
i-0a1b2c3d4e5f60718   ready       3/20    17    -                            3.36.1.2         acme,globex,trina
i-0f1e2d3c4b5a69788   ready       0/20    20    2026-11-02T03:10:00Z (2.1h)  3.36.4.5
```

`hosts scale` runs a pass now, `hosts keep|unkeep <id>`, `hosts resume`; `/internal/metrics` has `tdcloud_hosts`,
`tdcloud_host_slots_free` and `tdcloud_teams_waiting_for_host`. Every decision is in the audit log (`hosts.scale_out`,
`host.ready`, `team.waiting_for_host`, `team.host_assigned`, `hosts.scale_in`, `host.boot_failed`, `host.gone`,
`host.lost`).

The control role's IAM for this (`infra/terraform/iam.tf`): `autoscaling:DescribeAutoScalingGroups`,
`ec2:DescribeInstances` / `DescribeVolumes` / `DescribeAddresses` (no resource-level permissions exist for these);
`autoscaling:SetDesiredCapacity`, `SetInstanceProtection`, `TerminateInstanceInAutoScalingGroup` on the
`tdcloud-hosts` group only; `ec2:DeleteVolume` on volumes tagged `tdcloud:role=host`; `ec2:AllocateAddress` only with
the tag `tdcloud:pool=hosts` (and `CreateTags` only as part of that allocation), `ec2:ReleaseAddress` only on
addresses with that tag. `TDCLOUD_AUTOSCALE=0` turns the scaler off (then: every SSM-online host with the tag, as
before, sized by hand).

**Making it live on AWS** (the deployment predates it): push a control image built from this code and roll it to the
control instance (Operations above; nothing to roll on hosts — there are none), then

```sh
# terraform.tfvars: host_count is gone → host_max = 3
terraform apply -var-file=$S/terraform.tfvars
#   ~ aws_autoscaling_group.hosts      max_size 0 → 3 (min stays 0, desired is no longer Terraform's)
#   ~ aws_iam_role_policy.control       + PoolRead, PoolSize, HostVolumes, PoolAddress* statements
#   ~ aws_s3_object.artifacts["host/bootstrap.sh"], ["host/tdcloud-host"]   ready mark, info fields, address wait
#   (aws_eip.hosts had count 0 since the hold: nothing to destroy; the host_elastic_ips output becomes hosts_asg_name)
# /tdcloud/control/env: add TDCLOUD_MAX_HOSTS=3 (TDCLOUD_ASG_NAME defaults to tdcloud-hosts; `terraform output
# control_env_template` has the new lines), then rerun the control bootstrap
```

## Cost estimate (AWS, Seoul, on-demand, USD per month)

Prices from the AWS Price List API on 2026-10-23: m7g.xlarge $0.2006/h ($146.44/month), t4g.small $0.0208/h, gp3
$0.0912/GB-month, S3 Standard $0.025/GB-month, public IPv4 $0.005/h ($3.65/month), data out $0.126/GB after the
first 100 GB. Assumptions: 80% Team / 20% Business (1.2 slots per team), 20 slots per m7g.xlarge host (4 vCPU,
16 GiB; an idle team uses ~170 MiB, limits are caps), **10 GB stored per team**, 7 daily full backups plus up to 7
days of deleted versions (~14 copies = 140 GB of S3 per team), 3 GB/month data out per team, hosts with a 300 GB
data volume.

| | 10 teams | 50 teams | 200 teams |
|---|---|---|---|
| Team hosts (m7g.xlarge) | 1 → $146 | 3 → $439 | 12 → $1,757 |
| Control (t4g.small; t4g.medium at 200) | $15 | $15 | $30 |
| EBS gp3 (30 GB root + 300 GB data per host, control 30 GB) | $33 | $93 | $364 |
| Public IPv4 (hosts + control) | $7 | $15 | $47 |
| S3 backups (1.4 / 7 / 28 TB) | $35 | $175 | $700 |
| Data out | $0 | $6 | $63 |
| Route 53, KMS, ECR, SES, logs | ~$4 | ~$6 | ~$15 |
| **Total** | **~$241** | **~$749** | **~$2,977** |
| per team | ~$24 | ~$15 | ~$15 |

The first deploy (one m7g.xlarge host with a 50 GB data volume, the control instance, three public IPv4 addresses)
runs at about **$6/day** (~$180/month). **On hold** (control stopped, no hosts): control root volume 30 GB $2.74,
its Elastic IP $3.65, KMS key $1, Route 53 zone $0.50, ECR/S3 a few cents — **about $8/month**. Hosts follow the
teams ([scaler](#hosts-scale-out-and-scale-in)): with the control instance running and no paying team, there is no
host and no host address (the control plane allocates a host's Elastic IP just before it launches and releases it
after the scale-in), **~$27/month** (t4g.small $15 + its root volume and address). The first paying team starts the
first host: **+~$180/month** (m7g.xlarge $146, 300 GB data + 30 GB root gp3 $30, its address $3.65), billed from the
minute it launches; a host that has had no team for 6 hours costs nothing from then on. Up to 20 Team-plan teams
share it, the 21st starts the second. `host_max = 3` (12 vCPU of hosts + 2 for the control instance) stays inside
Seoul's default 16-vCPU quota for standard instances; more needs a quota increase first.

Against $99/month (Team) the infrastructure is 15–25% of revenue. The two big levers: a 1-year Compute Savings Plan
takes roughly a quarter off EC2, and **incremental backups** (instead of 7 full copies) would cut S3 by ~80% —
at 200 teams $700 → ~$140. At 10 teams one host is a single point of failure (recovery = restore from S3 onto a new
host; RPO 24 h). An m7g.large host (10 slots, $73) halves the 10-team compute but leaves no headroom.

## Configuration (control plane environment)

| Variable | Default | |
|---|---|---|
| `TDCLOUD_ENV` | — | `production` refuses the outbox mailer, a missing KMS key, a missing webhook secret or ask key |
| `TDCLOUD_DOMAIN` | `cloud.localhost` | teams at `<slug>.<domain>` |
| `TDCLOUD_CONTROL_URL` | `https://<domain>` | |
| `TDCLOUD_PUBLIC_PORT` | 443 | dev: 8443 |
| `TDCLOUD_DRIVER` | `local` | `local` (Docker CLI), `aws` (SSM), `fake` (tests) |
| `TDCLOUD_IMAGE` | `trina-drive:dev` | image for new teams and `teams upgrade` |
| `TDCLOUD_HELPER_IMAGE` | `tdcloud-control:dev` | this image, run on hosts for `seal` / `seal-dir` |
| `TDCLOUD_SECCOMP`, `TDCLOUD_APPARMOR` | `docker/seccomp-bwrap.json`, `trina-drive-bwrap` | empty AppArmor = host without AppArmor |
| `TDCLOUD_MAILER`, `TDCLOUD_MAIL_FROM`, `TDCLOUD_OPS_EMAIL` | `outbox` | `resend` in production (or `ses`, `smtp`); From `Trina Cloud <cloud@drive.trina.app>` |
| `TDCLOUD_RESEND_API_KEY_PARAM`, `TDCLOUD_RESEND_API_KEY_FILE`, `TDCLOUD_RESEND_ENDPOINT` | —, `~/.config/trina-drive/resend-api-key`, `https://api.resend.com` | the Resend key: SSM SecureString (required in production with `resend`), else a 0600 file |
| `TDCLOUD_SMTP_HOST`, `_PORT`, `_TLS`, `_USER`, `_PASS_PARAM`, `_PASS_FILE` | `smtp.resend.com`, 465, implicit, `resend`, the Resend key's | `TDCLOUD_MAILER=smtp` / relay upstream `smtp` |
| `TDCLOUD_TEAM_MAILER` | `relay` | team instances' mail: `relay` (the host's relay; Resend on AWS), `outbox` (a file in the team volume; refused in production), `off` |
| `TDCLOUD_TEAM_MAIL_FROM` | `Trina Drive <drive@trina.app>` | From of every team's mail (`drive@drive.trina.app` on AWS); the relay allows only this address |
| `TDCLOUD_TEAM_SUBNETS`, `TDCLOUD_MAIL_RELAY_PORT` | `10.128.0.0/11`, 8025 | the pool of team /28 networks (same value for the relay); the relay's port on each gateway |
| `TDCLOUD_KMS_KEY_ID` / `TDCLOUD_MASTER_KEY_FILE` | `<state>/master.key` | key wrapping |
| `TDCLOUD_BACKUP_TARGET`, `_KEEP`, `_EVERY_HOURS` | `dir:<state>/backups`, 14, 24 | `s3://bucket/prefix` on AWS |
| `TDCLOUD_PAST_DUE_GRACE_DAYS`, `_CANCELED_GRACE_DAYS`, `_DELETE_AFTER_DAYS` | 7, 3, 30 | |
| `TDCLOUD_CADDY_ASK_KEY` | — | required in production |
| `TDCLOUD_TRUSTED_PROXIES` | — | peers whose X-Forwarded-For is believed |
| `TDCLOUD_MAX_TEAMS_PER_HOST` | 20 | slots per host (Team = 1, Business = 2) |
| `TDCLOUD_AUTOSCALE` | 1 (`0` with the fake driver) | the host scaler; `0`: a fixed pool ([Hosts](#hosts-scale-out-and-scale-in)) |
| `TDCLOUD_MAX_HOSTS` | 3 | most hosts the scaler runs (also capped by the ASG's max size, `host_max`) |
| `TDCLOUD_SPARE_SLOTS` | 0 | free slots kept ready ahead of sign-ups |
| `TDCLOUD_EMPTY_HOST_GRACE` | `6h` | a host no team names for this long is terminated (durations: `6h`, `30m`, `45s`; bare number = hours) |
| `TDCLOUD_HOST_BOOT_TIMEOUT`, `TDCLOUD_HOST_WAIT_ALERT` | `15m`, `15m` | a host not booted by then is replaced; ops hear about a team waiting this long |
| `TDCLOUD_SCALER_EVERY` | `60s` | scaler passes when nothing happens (every 5 s while a team waits or a host boots) |
| `TDCLOUD_ASG_NAME` | `tdcloud-hosts` | the hosts' Auto Scaling group (AWS) |
| `TDCLOUD_LOCAL_HOST_BOOT` | `5s` | local driver: a simulated host's boot time |
| `TDCLOUD_ROUTE53_ZONE_ID`, `TDCLOUD_SSM_PREFIX`, `TDCLOUD_AWS_HOST_TAG`, `AWS_REGION` | —, `/tdcloud`, `host`, `ap-northeast-2` | AWS driver |
| `PADDLE_ENV`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN`, `PADDLE_CHECK_IP`, `PADDLE_WEBHOOK_TOLERANCE_SEC` | sandbox, —, —, off, 5 | |
| `PADDLE_PRICE_{TEAM,BUSINESS}_{MONTHLY,YEARLY}` | — | price id → plan, and the dashboard's checkout buttons |

The mail relay (`mail-relay`, on each host): `TDCLOUD_TEAM_MAIL_FROM`, `TDCLOUD_TEAM_SUBNETS`,
`TDCLOUD_MAIL_RELAY_LISTEN` (`0.0.0.0:8025`), `TDCLOUD_MAIL_UPSTREAM` (`resend`, `ses`, `smtp`, or `outbox:<file>` in
dev; unset: `ses`, or the older name `TDCLOUD_MAIL_RELAY_UPSTREAM`; the bootstrap passes `resend`), the Resend / SMTP
settings above (on hosts `TDCLOUD_RESEND_API_KEY_PARAM=/tdcloud/hosts/resend-api-key`),
`TDCLOUD_MAIL_RELAY_PER_HOUR` / `_PER_DAY` (60 / 500), `TDCLOUD_SES_CONFIGURATION_SET`, `AWS_REGION`. Caddy on the
hosts: `TDCLOUD_FRONT_PROXIES` (empty; [Client addresses](#client-addresses)).

## Upgrade path: Business on its own VM

The scaler places a team on a ready host of the `tdcloud-hosts` group. A dedicated host for one Business customer
is the same launch template in a second group (its own tag value and a capacity of one) — the pool and the scaler
would need to know more than one group (not built); moving
an existing team is backup → provision on the new host → restore → DNS switch (a `teams move` command is the
natural next step; not built). The container, limits and keys stay the same.

## Known gaps and follow-ups

Done here (the product side came with PR #18): client addresses behind Caddy (fixed team networks,
`TDRIVE_TRUSTED_PROXY`, Caddy overwriting `X-Forwarded-For`), mail from team instances (the host relay → Resend,
or SES with the instance role; only the team From), hosted mode (`TDRIVE_HOSTED=1`; the end-to-end test enrols TOTP),
managed storage with the plan's quota (100 GB / 1 TB), the setup link with `#token=`.

Before a real AWS launch:

1. **First AWS run (2026-10-23), what it covered.** Provisioning over SSM (sealed setup token and backup key),
   the team's uid, read-only root, seccomp/AppArmor, limits, no ports, its fixed /28 with Caddy at .2, the hosted-mode
   env (hosted, trusted proxy, managed storage 100 GB, SES through the relay), the XFS project quota (220 GB);
   from inside the team: DNS and HTTPS to the internet work, the metadata service, the VPC (control plane) and the
   host's other ports do not, the relay does; the relay refuses another From and passes the team From to SES (IAM
   allowed it; SES refused only because the identity is not verified yet); Caddy's `ask` (200 for the team, 404
   unknown, 403 without the key); manual backup to S3 (SSE-KMS) and `teams export` (KMS unwrap, decrypts); suspend;
   the audit chain. **Not yet covered** (needs the Gabia NS records and SES production access): certificates,
   `https://` end to end, Claude.ai connecting, real mail (setup link, invites), a Paddle purchase, a host reboot
   (Caddy re-joining the team networks), two teams on one host. Fixed on the way: the firewall script was not
   executable (teams would have run unfirewalled; the bootstrap now stops instead), the aws CLI snap writes nothing to
   a file when run under SSM (the control plane came up with an empty env; team env files would have been empty),
   S3 object etag vs KMS, an apostrophe EC2 refuses in a rule description, the KMS lockout check, SES checking the
   address identity before the domain verifies, ECR logins expiring after 12 h (credential helper now), backups
   uploaded with `--sse aws:kms` landing under the AWS-managed `aws/s3` key instead of the Trina Cloud key.
2. **Mail**: AWS denied SES production access (2026-10-23); mail goes through Resend (`drive.trina.app` verified, a
   test send from `drive@drive.trina.app` succeeded) — not yet live on AWS ([Switching to Resend](#switching-a-deployment-to-resend)).
   Bounces and complaints are not handled: Resend suppresses hard bounces itself, but nothing here reads its webhooks
   (`email.bounced`, `email.complained`) to stop mailing a team member. Resend's API rate limit is per account and
   shared by the control plane and every host: short bursts wait out the 429s, a sustained burst fails (the relay
   answers 502, the control plane reports the failed setup mail to ops: `teams resend-setup`). Team mail shows
   `Trina Drive` as the sender; the relay already accepts `<team> via Trina Drive`, but the control plane does not yet
   write the team's name into `TDRIVE_MAIL_FROM` (follow-up).
3. **Host disk vs. plan size**: a Business team may hold 1 TB (XFS cap 2 TB) while hosts start with a 300 GB data
   volume. Quotas are caps, not reservations: watch free space per host (`tdcloud-host info` reports it; nothing
   alerts yet), grow volumes online, and give large Business teams their own host (see Upgrade path).
4. The relay's per-team limits are in memory (reset on restart) and per host; its only log is stdout (team number and
   recipient domain).
5. `serve` logs "public listener NOT started (gate)" on every team start: expected (the team is served through the
   main listener behind Caddy), but noisy (product).
6. Backups are full copies (no incremental/dedup); restore is a documented manual procedure, with no automated
   restore drill yet.
7. One control instance; one host per team (no failover). Control DB copied nightly.
8. Monitoring: `/internal/metrics` (Prometheus text: teams by status, disk per team, pending/failed jobs, backup age)
   exists but nothing scrapes it; no CloudWatch alarms yet.
9. Seats (AI-connected people) are billed by Paddle, not enforced in the instance.
10. Local driver: no hard disk quota (named volumes have none); the product's storage quota still applies, and the
    metrics loop flags `/data` beyond it plus 20 GB.
11. A plan change recreates the container (a few seconds of downtime) because the storage quota is an env value.
12. Admin CLI through `docker exec` records the actor as `admin:unknown` (no `USER` in the container): pass
    `-e USER=<you>` to `docker exec`.
13. A team container can also reach the relay port on the host's VPC address (not only its gateway); the relay still
    accepts only a team container's address and the team From.
14. No `teams restore`: bringing a team back after hold mode or a lost host is the manual procedure above.
15. Hosts are packed (the fullest host that fits) but teams are never moved: a host with one team left stays until
    that team goes. A `teams move` (backup → restore on another host → DNS) would let the scaler consolidate.
16. The scaler's first AWS run is still ahead: it is tested locally (simulated hosts) and against fake Auto Scaling /
    EC2 endpoints. Watch the first scale-out and scale-in (`hosts list`, the audit log), and the Elastic IP quota
    (5 per region by default: `host_max` + the control instance's).
