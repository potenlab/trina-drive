#!/usr/bin/env bash
# Trina Cloud — first boot of an EC2 instance (Ubuntu 24.04, arm64). The launch template's user data
# (cloud/infra/terraform/user-data.sh.tftpl) writes /etc/tdcloud/host.conf and runs this script from the artifacts bucket.
#
# ROLE=host     a team host: Docker, the AppArmor profile for bwrap, an XFS data volume with project quotas at
#               /srv/tdcloud, a firewall that keeps team containers off the VPC, the metadata service and each other,
#               an Elastic IP from the pool, Caddy, the mail relay (team mail → SES with this instance's role), and the
#               host agent (tdcloud-host) for the control plane's SSM commands.
# ROLE=control  the control host: Docker, the control-plane container on 127.0.0.1:8790 (env from SSM Parameter
#               Store), Caddy (Caddyfile.control) for https://<domain>, nightly copy of the control database to S3.
#
# No SSH: the security groups have no port 22 and there are no keys; operators use SSM Session Manager.
set -euxo pipefail
exec > >(tee -a /var/log/tdcloud-bootstrap.log) 2>&1
# shellcheck source=/dev/null
. /etc/tdcloud/host.conf
: "${ROLE:?}" "${REGION:?}" "${ARTIFACTS_BUCKET:?}" "${ECR_REGISTRY:?}" "${DOMAIN:?}"
[ "$ROLE" = host ] && : "${TEAM_MAIL_FROM:?}" "${TEAM_SUBNETS:?}"
export DEBIAN_FRONTEND=noninteractive AWS_DEFAULT_REGION=$REGION PATH=$PATH:/snap/bin

# ---- packages (unattended-upgrades is on by default on Ubuntu; security updates apply daily)
apt-get update -q
apt-get install -y -q docker.io xfsprogs apparmor-utils jq curl unzip
snap install aws-cli --classic || true
systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service || true

# ---- Docker daemon: no inter-container traffic on the default bridge, logs capped, live restore across daemon updates
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "icc": false,
  "live-restore": true,
  "userland-proxy": false,
  "no-new-privileges": true,
  "default-address-pools": [{ "base": "172.30.0.0/15", "size": 24 }],
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
systemctl restart docker

# ---- files from the artifacts bucket (uploaded by Terraform from this repository)
mkdir -p /etc/tdcloud
aws s3 cp "s3://$ARTIFACTS_BUCKET/host/tdcloud-host" /usr/local/sbin/tdcloud-host
chmod 0755 /usr/local/sbin/tdcloud-host
aws s3 cp "s3://$ARTIFACTS_BUCKET/docker/seccomp-bwrap.json" /etc/tdcloud/seccomp-bwrap.json
aws s3 cp "s3://$ARTIFACTS_BUCKET/docker/apparmor-trina-drive-bwrap" /etc/apparmor.d/trina-drive-bwrap
apparmor_parser -r /etc/apparmor.d/trina-drive-bwrap

# ---- images (ECR in this account). `docker login` tokens last 12 hours, and the control plane pulls new images over
# SSM long after boot (`teams upgrade`): the ECR credential helper signs every pull with this instance's role instead.
apt-get install -y -q amazon-ecr-credential-helper || echo "WARNING: no ECR credential helper; pulls after 12 h need a new docker login" >&2
if command -v docker-credential-ecr-login >/dev/null; then
  mkdir -p /root/.docker && chmod 0700 /root/.docker
  printf '{ "credHelpers": { "%s": "ecr-login" } }\n' "$ECR_REGISTRY" > /root/.docker/config.json
else
  aws ecr get-login-password | docker login --username AWS --password-stdin "$ECR_REGISTRY"
fi
docker pull "$CADDY_IMAGE"
docker pull "$CONTROL_IMAGE"
[ "$ROLE" = host ] && docker pull "$TRINA_IMAGE"

if [ "$ROLE" = host ]; then
  # ---- data volume: the second EBS volume (not the root disk), XFS with project quotas, at /srv/tdcloud
  root_disk=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)")
  data_disk=$(lsblk -dno NAME,TYPE | awk -v r="$root_disk" '$2 == "disk" && $1 != r {print $1; exit}')
  [ -n "$data_disk" ] || { echo "no data volume attached" >&2; exit 1; }
  blkid "/dev/$data_disk" >/dev/null || mkfs.xfs -L tdcloud "/dev/$data_disk"
  mkdir -p /srv/tdcloud
  grep -q ' /srv/tdcloud ' /etc/fstab || echo "LABEL=tdcloud /srv/tdcloud xfs defaults,noatime,prjquota 0 2" >> /etc/fstab
  mount /srv/tdcloud || mount -o remount /srv/tdcloud
  mkdir -p /srv/tdcloud/teams && chmod 0711 /srv/tdcloud /srv/tdcloud/teams
  touch /etc/projects /etc/projid

  # ---- firewall: team bridges are named tdcb<n> (drivers/docker.ts). Team containers reach the internet (OAuth
  # client metadata from claude.ai / chatgpt.com) and nothing private: not the metadata service, not the VPC, not
  # other Docker networks, not the host — except the mail relay's port on their own gateway. Traffic inside one team
  # bridge (Caddy <-> that team) and Docker's own isolation between bridges are left to Docker (RETURN). The relay's
  # port takes nothing from anywhere else (the security group does not open it either). Re-applied after every
  # Docker start.
  cat > /usr/local/sbin/tdcloud-firewall <<EOF
#!/bin/sh
set -e
iptables -N DOCKER-USER 2>/dev/null || true
iptables -F DOCKER-USER
iptables -A DOCKER-USER -i tdcb+ -o tdcb+ -j RETURN
iptables -A DOCKER-USER -i tdcb+ -d 169.254.0.0/16 -j DROP
iptables -A DOCKER-USER -i tdcb+ -d ${VPC_CIDR:-10.42.0.0/16} -j DROP
iptables -A DOCKER-USER -i tdcb+ -d 10.0.0.0/8 -j DROP
iptables -A DOCKER-USER -i tdcb+ -d 172.16.0.0/12 -j DROP
iptables -A DOCKER-USER -i tdcb+ -d 192.168.0.0/16 -j DROP
iptables -A DOCKER-USER -j RETURN
iptables -N TDCLOUD-INPUT 2>/dev/null || true
iptables -F TDCLOUD-INPUT
iptables -A TDCLOUD-INPUT -i tdcb+ -p tcp --dport ${MAIL_RELAY_PORT:-8025} -j ACCEPT
iptables -A TDCLOUD-INPUT -i tdcb+ -j DROP
iptables -A TDCLOUD-INPUT -i lo -j RETURN
iptables -A TDCLOUD-INPUT -p tcp --dport ${MAIL_RELAY_PORT:-8025} -j DROP
iptables -A TDCLOUD-INPUT -j RETURN
iptables -D INPUT -i tdcb+ -j DROP 2>/dev/null || true
iptables -C INPUT -j TDCLOUD-INPUT 2>/dev/null || iptables -I INPUT -j TDCLOUD-INPUT
EOF
  cat > /etc/systemd/system/tdcloud-firewall.service <<'EOF'
[Unit]
Description=Trina Cloud team network rules
After=docker.service
Requires=docker.service
PartOf=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/tdcloud-firewall
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target docker.service
EOF
  chmod 0755 /usr/local/sbin/tdcloud-firewall
  systemctl daemon-reload
  systemctl enable tdcloud-firewall.service
  systemctl restart tdcloud-firewall.service
  # the team isolation rules are not optional: stop here if they are not in place
  iptables -C INPUT -j TDCLOUD-INPUT && iptables -C DOCKER-USER -i tdcb+ -d 169.254.0.0/16 -j DROP

  # ---- Elastic IP from the pool (stable address for the teams' DNS records)
  token=$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
  iid=$(curl -sf -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/instance-id)
  if ! aws ec2 describe-addresses --filters "Name=instance-id,Values=$iid" --query 'Addresses[0].AllocationId' --output text | grep -q eipalloc; then
    for alloc in $(aws ec2 describe-addresses --filters "Name=tag:tdcloud:pool,Values=$EIP_POOL" --query 'Addresses[?AssociationId==null].AllocationId' --output text); do
      aws ec2 associate-address --instance-id "$iid" --allocation-id "$alloc" --no-allow-reassociation && break || true
    done
  fi
fi

# ---- Caddy
mkdir -p /etc/tdcloud
if [ "$ROLE" = host ]; then
  ask_key=$(aws ssm get-parameter --with-decryption --name "$CADDY_ASK_KEY_PARAM" --query Parameter.Value --output text)
  cat > /etc/tdcloud/caddy.env <<EOF
TDCLOUD_DOMAIN=$DOMAIN
TDCLOUD_SLUG_LABEL=$(awk -F. '{print NF}' <<<"$DOMAIN")
TDCLOUD_ASK_URL=http://$CONTROL_PRIVATE_IP:8790/internal/caddy/ask?key=$ask_key
ACME_EMAIL=$ACME_EMAIL
TDCLOUD_FRONT_PROXIES=${FRONT_PROXIES:-}
EOF
  chmod 0600 /etc/tdcloud/caddy.env
  docker network inspect tdc-edge >/dev/null 2>&1 || docker network create tdc-edge
  docker rm -f tdc-caddy 2>/dev/null || true
  docker run -d --name tdc-caddy --restart unless-stopped --network tdc-edge -p 80:80 -p 443:443 \
    --env-file /etc/tdcloud/caddy.env -v caddy-data:/data -v caddy-config:/config \
    --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges:true \
    --memory 512m --pids-limit 256 \
    "$CADDY_IMAGE" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
  # team networks that already exist (a reboot): Caddy joins them again at its fixed address on each (the label the
  # control plane put on the network); the team trusts X-Forwarded-For from that address only
  for n in $(docker network ls --filter label=tdcloud.team --format '{{.Name}}'); do
    ip=$(docker network inspect -f '{{index .Labels "tdcloud.caddy-ip"}}' "$n")
    docker network connect ${ip:+--ip "$ip"} "$n" tdc-caddy 2>/dev/null || true
  done

  # ---- the mail relay: team instances send mail (SES v2 API) to their network's gateway, port 8025; the relay checks
  # the sender and the From and signs for SES with this instance's role (cloud/control/src/relay.ts). Host network:
  # it must reach the metadata service (hop limit 1) and listen on every team gateway.
  docker rm -f tdc-mail 2>/dev/null || true
  docker run -d --name tdc-mail --restart unless-stopped --network host \
    -e AWS_REGION="$REGION" -e TDCLOUD_TEAM_MAIL_FROM="$TEAM_MAIL_FROM" -e TDCLOUD_TEAM_SUBNETS="$TEAM_SUBNETS" \
    -e TDCLOUD_MAIL_RELAY_LISTEN="0.0.0.0:${MAIL_RELAY_PORT:-8025}" -e TDCLOUD_MAIL_RELAY_UPSTREAM=ses \
    --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 256m --pids-limit 128 \
    --no-healthcheck "$CONTROL_IMAGE" mail-relay
else
  # ---- control host: the control plane (127.0.0.1:8790) and Caddy in front of it, host network for both
  # through a pipe: the aws CLI snap run from the SSM agent (a rerun of this script) writes nothing when its stdout is
  # a file (0 bytes, exit 0), and the control plane then started with an empty env (local driver, cloud.localhost)
  aws ssm get-parameter --with-decryption --name "$CONTROL_ENV_PARAM" --query Parameter.Value --output text | cat > /etc/tdcloud/control.env
  grep -q '^TDCLOUD_DOMAIN=' /etc/tdcloud/control.env || { echo "control env from $CONTROL_ENV_PARAM is empty or has no TDCLOUD_DOMAIN" >&2; exit 1; }
  chmod 0600 /etc/tdcloud/control.env
  mkdir -p /var/lib/tdcloud && chown 10002:10002 /var/lib/tdcloud && chmod 0700 /var/lib/tdcloud
  docker rm -f tdc-control tdc-caddy 2>/dev/null || true
  docker run -d --name tdc-control --restart unless-stopped --network host --env-file /etc/tdcloud/control.env \
    -e TDCLOUD_LISTEN_HOST=0.0.0.0 -e TDCLOUD_LISTEN_PORT=8790 -e TDCLOUD_TRUSTED_PROXIES=127.0.0.1 \
    -v /var/lib/tdcloud:/var/lib/tdcloud --read-only --tmpfs /tmp:size=64m --cap-drop ALL --security-opt no-new-privileges:true \
    --memory 1g "$CONTROL_IMAGE" serve
  cat > /etc/tdcloud/caddy.env <<EOF
TDCLOUD_DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
EOF
  docker run -d --name tdc-caddy --restart unless-stopped --network host --env-file /etc/tdcloud/caddy.env \
    -v caddy-data:/data -v caddy-config:/config --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges:true \
    "$CADDY_IMAGE" caddy run --config /etc/caddy/Caddyfile.control --adapter caddyfile
  # nightly consistent copy of the control database to the backup bucket (versioned; the bucket's default SSE-KMS with
  # the Trina Cloud key: no --sse flag, which would pick the AWS-managed aws/s3 key)
  cat > /etc/cron.d/tdcloud-control-backup <<EOF
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
23 2 * * * root f=/var/lib/tdcloud/control-snapshot.db; rm -f \$f; docker exec tdc-control bun /app/src/main.ts db snapshot \$f && aws s3 cp --only-show-errors \$f s3://$BACKUP_BUCKET/control/control-\$(date -u +\%Y\%m\%dT\%H\%M\%SZ).db; rm -f \$f
EOF
fi
echo "tdcloud bootstrap done ($ROLE)"
