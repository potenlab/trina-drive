data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

# Ubuntu 24.04 LTS arm64, the current Canonical image (resolved at plan time)
data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

locals {
  account      = data.aws_caller_identity.current.account_id
  partition    = data.aws_partition.current.partition
  ecr_registry = "${local.account}.dkr.ecr.${var.region}.amazonaws.com"
  images = {
    trina   = "${aws_ecr_repository.repo["trina-drive"].repository_url}:${var.trina_image_tag}"
    control = "${aws_ecr_repository.repo["tdcloud-control"].repository_url}:${var.control_image_tag}"
    caddy   = "${aws_ecr_repository.repo["tdcloud-caddy"].repository_url}:${var.caddy_image_tag}"
  }
  # parameters the owner creates by hand before the first apply (secrets never pass through Terraform state)
  ssm_control_env = "/${var.name}/control/env"
  ssm_ask_key     = "/${var.name}/caddy-ask-key"
  ssm_teams       = "/${var.name}/teams"
}
