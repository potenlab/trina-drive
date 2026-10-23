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
```

Status: **runs end to end locally** (two teams, 149 checks), with every team in hosted mode (admins enrol a
second factor), behind Caddy as its one trusted proxy, on managed storage with the plan's quota, and sending its own
mail through the host's mail relay. The AWS path (driver, host agent, mail relay → SES, Terraform) is written and
unit-tested against fake AWS endpoints, and was **deployed once to AWS on 2026-10-23** (one control instance, one
m7g.xlarge host, the dogfood team `trina`): provisioning over SSM, hosted-mode settings, the host firewall, the mail
relay up to SES, backups to S3 and an export through KMS all worked; DNS delegation, TLS certificates and real mail wait
on the Gabia NS records and SES. The deployment is now in [hold mode](#hold-mode-no-teams-until-the-first-customer).
See [Known gaps](#known-gaps-and-follow-ups) before launch.

## How it works

```mermaid
flowchart LR
  B["Buyer"] -->|sign up, pay| C["Control plane<br/>https://cloud.trina.app"]
  P["Paddle"] -->|signed webhook| C
  C -->|SSM Run Command<br/>(local: Docker CLI)| H
  C -->|A record per team| R[("Route 53<br/>cloud.trina.app")]
  C -->|setup link| M["SES mail"]
  subgraph H["Team host (EC2, Docker)"]
    K["Caddy<br/>on-demand TLS, rate limits<br/>.2 on every team network"] --> A["tdc-acme<br/>uid 20001 · own /28 network"]
    K --> G["tdc-globex<br/>uid 20002 · own /28 network"]
    A --- VA[("acme volume<br/>XFS quota")]
    G --- VG[("globex volume<br/>XFS quota")]
    A -.->|invites, resets| R["mail relay<br/>(host network, instance role)"]
    G -.-> R
  end
  R -->|SendEmail, team From only| M
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
4. **Provision** (a job, retried with backoff, operator alerted after 5 failures): pick the least-loaded host, create
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
(`TDCLOUD_TEAM_MAIL_FROM`), at most 60 per hour and 500 per day per team (`TDCLOUD_MAIL_RELAY_PER_HOUR` / `_PER_DAY`),
and sends it with the instance role. The host role's IAM allows `ses:SendEmail` on the one SES identity with condition
`ses:FromAddress` = the team address (`iam.tf`, `TeamMail`); the control plane's role likewise only from
`cloud@<mail domain>`. The `AWS_*` values in a team's env file are placeholders the product needs to sign at all, not
credentials. Locally the relay writes to `dev/.state/team-mail.log` instead of SES.

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
survive, same address and env); the audit chain verifies and has every action. Last run: **149/149 passed in 87 s**.

Unit tests (`cd cloud/control && bun test`, 42 tests): the billing state machine with a fake driver (grace,
suspend, resume, cancel → final backup → delete, resubscription, stale and foreign events, failed provisioning),
sealing (tampering, truncation), the AWS SigV4 test vector, sealed SSM outputs, Route 53/KMS request shapes, the
docker arguments of a team container; team network addresses, the team env (the product's own `mailEnv` accepts it),
the relay's checks and limits, the product's `SesMailer` through the relay to a fake SES signed with the host role, a
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

Mail goes out from the cloud domain itself (`mail_domain` empty = `domain`): `cloud@cloud.trina.app` (control plane)
and `Trina Drive <drive@cloud.trina.app>` (teams). Its three DKIM CNAMEs and a DMARC record go into the Route 53 zone,
so nothing but the delegation is added at Gabia. (With `mail_domain = "trina.app"`, add the CNAMEs from
`ses_dkim_records` at Gabia instead.)

**2. Gabia (trina.app DNS), once.** In 가비아 → DNS 관리 → trina.app → 레코드 수정, add **four NS records** with host
`cloud`, one per value of `name_servers` (e.g. `cloud  NS  ns-123.awsdns-15.com.`). Nothing else changes at Gabia
(not the apex, not `drive`). Check: `dig NS cloud.trina.app +short` shows the four Route 53 servers. The SES identity
`cloud.trina.app` then verifies itself within the hour (`aws sesv2 get-email-identity --email-identity cloud.trina.app`).

**3. SES.** Request **production access** (until then SES sends only to verified addresses; the setup link to a new
team's owner fails and is reported to ops — `teams resend-setup` later):

```sh
aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL --website-url https://drive.trina.app \
  --contact-language EN --use-case-description "<transactional only: confirmations, setup links, invites, resets>"
aws sesv2 put-account-suppression-attributes --suppressed-reasons BOUNCE COMPLAINT
```

Both senders are in the one domain identity; `team_mail_address` changes the teams' address (the roles may send only
from their own address: `ses:FromAddress`, which SES compares with the address part of `Name <address>`).

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
terraform output -raw control_env_template > control.env    # fill in the <…> lines (ask key, Paddle values)
# Paddle not ready yet? A random PADDLE_WEBHOOK_SECRET placeholder and no price ids: the control plane starts, nothing
# can be bought, operator-made teams (`teams create`) work
aws ssm put-parameter --type SecureString --key-id alias/tdcloud --name /tdcloud/control/env --value file://control.env
rm -P control.env
```

**7. Everything else:** `terraform apply -var-file=$S/terraform.tfvars` (control instance + Elastic IP +
`cloud.trina.app` A record, the host ASG and its Elastic IPs). First boot takes ~3 minutes
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
running). Changed host scripts reach the artifacts bucket with `terraform apply -target=aws_s3_object.artifacts`. More capacity: raise `host_count`, `terraform apply` (new teams go to the least-loaded host;
`TDCLOUD_MAX_TEAMS_PER_HOST` slots each). Product upgrade: push a new `trina-drive` tag, set `TDCLOUD_IMAGE` in
`/tdcloud/control/env`, rerun the control bootstrap, then `teams upgrade --all` (each team: backup, new container on
the same data). Backups of the control database: nightly to `s3://<backup bucket>/control/`.

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

Going on hold:

```sh
# 1. each team: a last backup, stopped (kept in the control DB as suspended), host-side removed, DNS record removed
docker exec tdc-control bun /app/src/main.ts teams backup <slug>; … teams suspend <slug>
#    on its host: docker rm -f tdc-<slug>; docker network rm tdc-net-<slug>; tdcloud-host cleanup <slug>
aws ssm delete-parameter --name /tdcloud/teams/<slug>/env
aws route53 change-resource-record-sets … DELETE <slug>.cloud.trina.app A <host EIP>
# 2. a copy of the control DB in S3 (the nightly cron does not run while it is stopped)
# 3. hosts: scale-in protection off, then host_count = 0
aws autoscaling set-instance-protection --auto-scaling-group-name tdcloud-hosts --no-protected-from-scale-in --instance-ids <ids>
terraform apply -var-file=$S/terraform.tfvars        # host_count = 0: ASG 0/0/0, host EIPs released
aws ec2 delete-volume --volume-id <the host's /dev/sdf volume>   # kept on termination by design; the data is in S3
# 4. the control instance (nothing can sign up or pay yet: Paddle is not wired, SES is in the sandbox)
aws ec2 stop-instances --instance-ids <control instance id>
```

Coming back: `aws ec2 start-instances --instance-ids <control>` (its containers restart by themselves; Caddy gets
the `cloud.trina.app` certificate once Gabia delegates the zone), `host_count = 1` and `terraform apply` (a new host
boots in ~3 minutes with its own Elastic IP from the pool), then `teams create` for new teams. A team kept from before
the hold (the dogfood `trina`) is restored by hand onto the new host: `teams export` gives the archive and keys; there
is no `teams restore` yet, and its row still names the terminated host.

What automatic scale-out from 0 and scale-in of empty hosts would need (not built):

- **Out**: `pickHost` throws "no online host with room"; the provision job retries for ~7 minutes, then fails and
  alerts. Instead, on that error the control plane should raise the ASG's desired capacity (IAM:
  `autoscaling:SetDesiredCapacity` / `UpdateAutoScalingGroup` on `tdcloud-hosts`, max raised with it), keep the
  team in `provisioning` with a longer retry window (a host needs ~3 minutes to boot and register with SSM), and only
  pick a host whose bootstrap finished (SSM online is earlier than that: e.g. a `tdcloud:ready` tag the bootstrap sets,
  or `tdcloud-host info` answering). Each host also needs a free Elastic IP in the pool before it boots (the
  bootstrap takes one; with none it keeps its ephemeral address and team DNS records would point at that).
- **In**: a host is empty when no team row names it (`teams` with `host = <id>` and status not deleted).
  Remove its scale-in protection (`autoscaling:SetInstanceProtection`) and terminate it through the ASG
  (`TerminateInstanceInAutoScalingGroup --should-decrement-desired-capacity`), then delete its data volume
  (`delete_on_termination = false` on purpose) and release or keep its Elastic IP. Keep one host warm if sign-ups
  should not wait 3+ minutes.
- Both: `host_count` in Terraform must stop owning the ASG size (`ignore_changes = [desired_capacity]`, min 0,
  max = a cap), or the next apply undoes the control plane's choice.

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
its Elastic IP $3.65, KMS key $1, Route 53 zone $0.50, ECR/S3 a few cents — **about $8/month**.

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
| `TDCLOUD_MAILER`, `TDCLOUD_MAIL_FROM`, `TDCLOUD_OPS_EMAIL` | `outbox` | `ses` in production |
| `TDCLOUD_TEAM_MAILER` | `relay` | team instances' mail: `relay` (the host's relay; SES on AWS), `outbox` (a file in the team volume; refused in production), `off` |
| `TDCLOUD_TEAM_MAIL_FROM` | `Trina Drive <drive@trina.app>` | From of every team's mail; the relay and the hosts' IAM allow only this address |
| `TDCLOUD_TEAM_SUBNETS`, `TDCLOUD_MAIL_RELAY_PORT` | `10.128.0.0/11`, 8025 | the pool of team /28 networks (same value for the relay); the relay's port on each gateway |
| `TDCLOUD_KMS_KEY_ID` / `TDCLOUD_MASTER_KEY_FILE` | `<state>/master.key` | key wrapping |
| `TDCLOUD_BACKUP_TARGET`, `_KEEP`, `_EVERY_HOURS` | `dir:<state>/backups`, 14, 24 | `s3://bucket/prefix` on AWS |
| `TDCLOUD_PAST_DUE_GRACE_DAYS`, `_CANCELED_GRACE_DAYS`, `_DELETE_AFTER_DAYS` | 7, 3, 30 | |
| `TDCLOUD_CADDY_ASK_KEY` | — | required in production |
| `TDCLOUD_TRUSTED_PROXIES` | — | peers whose X-Forwarded-For is believed |
| `TDCLOUD_MAX_TEAMS_PER_HOST` | 20 | slots (Business = 2) |
| `TDCLOUD_ROUTE53_ZONE_ID`, `TDCLOUD_SSM_PREFIX`, `TDCLOUD_AWS_HOST_TAG`, `AWS_REGION` | —, `/tdcloud`, `host`, `ap-northeast-2` | AWS driver |
| `PADDLE_ENV`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN`, `PADDLE_CHECK_IP`, `PADDLE_WEBHOOK_TOLERANCE_SEC` | sandbox, —, —, off, 5 | |
| `PADDLE_PRICE_{TEAM,BUSINESS}_{MONTHLY,YEARLY}` | — | price id → plan, and the dashboard's checkout buttons |

The mail relay (`mail-relay`, on each host): `TDCLOUD_TEAM_MAIL_FROM`, `TDCLOUD_TEAM_SUBNETS`,
`TDCLOUD_MAIL_RELAY_LISTEN` (`0.0.0.0:8025`), `TDCLOUD_MAIL_RELAY_UPSTREAM` (`ses`, or `outbox:<file>` in dev),
`TDCLOUD_MAIL_RELAY_PER_HOUR` / `_PER_DAY` (60 / 500), `TDCLOUD_SES_CONFIGURATION_SET`, `AWS_REGION`. Caddy on the
hosts: `TDCLOUD_FRONT_PROXIES` (empty; [Client addresses](#client-addresses)).

## Upgrade path: Business on its own VM

The AWS driver places a team on any instance tagged `tdcloud:role=host`. A dedicated host for one Business customer
is the same launch template with a separate tag value and `TDCLOUD_MAX_TEAMS_PER_HOST`-style capacity of one; moving
an existing team is backup → provision on the new host → restore → DNS switch (a `teams move` command is the
natural next step; not built). The container, limits and keys stay the same.

## Known gaps and follow-ups

Done here (the product side came with PR #18): client addresses behind Caddy (fixed team networks,
`TDRIVE_TRUSTED_PROXY`, Caddy overwriting `X-Forwarded-For`), mail from team instances (the host relay → SES with the
instance role; IAM limited to the team From), hosted mode (`TDRIVE_HOSTED=1`; the end-to-end test enrols TOTP),
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
2. **SES**: production access was requested on 2026-10-23 (pending); the account-level suppression list (bounces,
   complaints) is on. The `ses:FromAddress` condition matches the address part of `Trina Drive <drive@…>` (the first
   run got past IAM with it). Bounces and complaints are not handled: add a configuration set with an SNS/EventBridge
   destination and suppress bad recipients (`TDCLOUD_SES_CONFIGURATION_SET` is passed through; the host IAM then also
   needs the configuration set's ARN).
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
