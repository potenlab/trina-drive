terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.80, < 7.0"
    }
  }
  # State: local by default. For a team, keep it in S3 (create the bucket by hand first, then uncomment):
  # backend "s3" {
  #   bucket       = "tdcloud-tfstate-<account-id>"
  #   key          = "tdcloud/terraform.tfstate"
  #   region       = "ap-northeast-2"
  #   encrypt      = true
  #   use_lockfile = true
  # }
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
