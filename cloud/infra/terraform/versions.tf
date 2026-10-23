terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.80, < 7.0"
    }
  }
  # State: local. The file holds resource ids, not secrets (those are in SSM), but keep it outside the repository:
  #   terraform init -backend-config="path=$HOME/.config/trina-drive/tdcloud-tf/terraform.tfstate"
  # For a team, keep it in S3 instead (create the bucket by hand first, replace the block below with this one):
  # backend "s3" {
  #   bucket       = "tdcloud-tfstate-<account-id>"
  #   key          = "tdcloud/terraform.tfstate"
  #   region       = "ap-northeast-2"
  #   encrypt      = true
  #   use_lockfile = true
  # }
  backend "local" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "trina-cloud"
      ManagedBy = "terraform"
    }
  }
}
