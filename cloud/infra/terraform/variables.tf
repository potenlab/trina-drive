variable "region" {
  description = "AWS region (Seoul by default; every service used here is available there)."
  type        = string
  default     = "ap-northeast-2"
}

variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "tdcloud"
}

variable "domain" {
  description = "Teams live at https://<slug>.<domain>; the control plane at https://<domain>. A Route 53 zone is created for it (delegate it from Gabia with NS records)."
  type        = string
  default     = "cloud.trina.app"
}

variable "mail_domain" {
  description = "Domain the control plane and the teams send mail from (SES identity). Empty = var.domain: the identity's DKIM CNAMEs then go into the Route 53 zone and nothing is added at Gabia. Another domain (e.g. trina.app): add the three CNAMEs from outputs.ses_dkim_records in its DNS by hand."
  type        = string
  default     = ""
}

variable "acme_email" {
  description = "Let's Encrypt account contact."
  type        = string
  default     = "contact@trina.app"
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "azs" {
  description = "Two availability zones for the public subnets."
  type        = list(string)
  default     = ["ap-northeast-2a", "ap-northeast-2c"]
}

variable "host_max" {
  description = "Most team hosts the control plane's scaler may run (the Auto Scaling group's max size; the scaler starts at 0 and also stops at TDCLOUD_MAX_HOSTS). Mind the account's vCPU quota: m7g.xlarge has 4 vCPU, the Seoul default for standard instances is 16 (control instance included)."
  type        = number
  default     = 3
  validation {
    condition     = var.host_max >= 0 && floor(var.host_max) == var.host_max
    error_message = "host_max is a whole number, 0 or more."
  }
}

variable "host_instance_type" {
  description = "Team host size (arm64). m7g.large = 2 vCPU / 8 GiB: 10 slots; m7g.xlarge = 4 vCPU / 16 GiB: 20 slots (a Team-plan team is 1 slot, Business 2; README, Sizing). TDCLOUD_MAX_TEAMS_PER_HOST in control_env_template follows it."
  type        = string
  default     = "m7g.large"
}

variable "host_data_gb" {
  description = "Team data volume per host (gp3, XFS with per-team project quotas). Plans include 100 GB (Team) and 1 TB (Business) of files (XFS caps 220 GB / 2,020 GB with database and backup staging), but most teams use far less: size for actual use and grow the volume online."
  type        = number
  default     = 100
}

variable "control_instance_type" {
  type    = string
  default = "t4g.small"
}

variable "trina_image_tag" {
  description = "Tag of the trina-drive image in ECR that new teams run."
  type        = string
  default     = "0.2.0"
}

variable "control_image_tag" {
  type    = string
  default = "0.1.0"
}

variable "caddy_image_tag" {
  type    = string
  default = "2.10.2-1"
}

variable "create_autoscaling_service_linked_role" {
  description = "Create AWSServiceRoleForAutoScaling (needed in the KMS key policy so the ASG can launch encrypted volumes). Set false if the account already has it."
  type        = bool
  default     = true
}

variable "manage_ses_identity" {
  description = "Create the SES domain identity for mail_domain (then add its DKIM CNAMEs at Gabia and request production access)."
  type        = bool
  default     = true
}

variable "team_mail_address" {
  description = "Address every team instance sends from (invites, password resets, notifications), in the sending domain (resend_domain with Resend, mail_domain with SES). Empty = drive@<that domain>. The relay (and, with SES, the hosts' role) lets teams send from this address only."
  type        = string
  default     = ""
}

variable "team_mail_name" {
  description = "Display name of the team instances' mail."
  type        = string
  default     = "Trina Drive"
}

variable "team_subnets" {
  description = "Pool for the team networks on the hosts: one /28 per team (gateway = mail relay, .2 = Caddy, .3 = the team). Must not overlap vpc_cidr. Same value as the control plane's TDCLOUD_TEAM_SUBNETS."
  type        = string
  default     = "10.128.0.0/11"
}

variable "office_cidrs" {
  description = "Client ranges (an office's NAT address, /32) that get the higher per-address rate limits in front of every team: one address carries a whole team there (caddy/team_routes.caddy: sign-in 300/min, MCP 1,500/min, all 6,000/min instead of 30/300/1,200). Not secret, but keep it in terraform.tfvars, not the repository. Reaches new hosts (launch template); running hosts: OFFICE_CIDRS in host.conf + bootstrap rerun."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for c in var.office_cidrs : can(cidrhost(c, 0))])
    error_message = "office_cidrs are CIDR ranges, e.g. 203.0.113.7/32."
  }
}

variable "front_proxies" {
  description = "CIDR ranges of a load balancer or CDN in front of the hosts' Caddy, if one is ever added (none today: DNS points at the hosts' Elastic IPs). Caddy then takes the client's address from X-Forwarded-For only from these (README, Client addresses)."
  type        = list(string)
  default     = []
}

variable "kms_admin_arns" {
  description = "IAM users/roles that administer the KMS key through its key policy. Needed when the identity running Terraform has no kms:PutKeyPolicy in IAM (KMS refuses a policy that would lock its creator out); e.g. [\"arn:aws:iam::<account>:user/tdcloud-deploy\"]."
  type        = list(string)
  default     = []
}

variable "mail_upstream" {
  description = "How mail leaves Trina Cloud, for the control plane (TDCLOUD_MAILER) and each host's mail relay (TDCLOUD_MAIL_UPSTREAM): resend (Resend's HTTPS API; the API key in the SSM SecureStrings <name>/control/resend-api-key and <name>/hosts/resend-api-key), ses (Amazon SES with the instance roles; needs SES production access) or smtp (SMTP submission, by default Resend's SMTP with the same key)."
  type        = string
  default     = "resend"
  validation {
    condition     = contains(["resend", "ses", "smtp"], var.mail_upstream)
    error_message = "mail_upstream is resend, ses or smtp."
  }
}

variable "resend_domain" {
  description = "Sending domain verified in Resend (region ap-northeast-1) when mail_upstream is resend or smtp: teams send as drive@<it>, the control plane as cloud@<it>. Its DNS is not in this Terraform (drive.trina.app is at Cloudflare): add the records from the Resend dashboard there (cloud/scripts/resend-domain.ts prints and checks them)."
  type        = string
  default     = "drive.trina.app"
}
