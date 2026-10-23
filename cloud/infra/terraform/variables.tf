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
  description = "Domain the control plane sends mail from (SES identity; DKIM CNAMEs go into its DNS at Gabia)."
  type        = string
  default     = "trina.app"
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

variable "host_count" {
  description = "Team hosts in the pool (the ASG's fixed size). Add one when the control plane says no host has room."
  type        = number
  default     = 1
}

variable "host_instance_type" {
  description = "Team host size (arm64). m7g.xlarge = 4 vCPU / 16 GiB: about 25 Team-plan teams (README, Sizing)."
  type        = string
  default     = "m7g.xlarge"
}

variable "host_data_gb" {
  description = "Team data volume per host (gp3, XFS with per-team project quotas). Plan quotas are 50 GB (Team) and 200 GB (Business), but most teams use far less: size for actual use and grow the volume online."
  type        = number
  default     = 500
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
