# Images: trina-drive (the product, built from the repository's Dockerfile), tdcloud-control and tdcloud-caddy
# (cloud/control, cloud/caddy). Tags are immutable; pushes are scanned.
resource "aws_ecr_repository" "repo" {
  for_each             = toset(["trina-drive", "tdcloud-control", "tdcloud-caddy"])
  name                 = each.key
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.main.arn
  }
}

resource "aws_ecr_lifecycle_policy" "keep" {
  for_each   = aws_ecr_repository.repo
  repository = each.value.name
  # Three rules (ECR applies each image to the highest-priority rule whose tags it matches; a lower rule never expires
  # it). buildx pushes an index (tagged) with an untagged image manifest and an untagged attestation per platform; ECR
  # never expires an image an index still references, and removes attestations with their subject.
  #   1. rollback-* tags: never expire (the known-good images a rollback goes back to, plan §6.5; one rule matching
  #      them with a count no repository reaches)
  #   2. every other tagged image: the newest 30 (counting tagged images only, not the attestations)
  #   3. untagged leftovers (children of an expired index, interrupted pushes): after 14 days
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "never expire rollback-* images"
        selection    = { tagStatus = "tagged", tagPrefixList = ["rollback-"], countType = "imageCountMoreThan", countNumber = 9999 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "keep the newest 30 tagged images"
        selection    = { tagStatus = "tagged", tagPatternList = ["*"], countType = "imageCountMoreThan", countNumber = 30 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 3
        description  = "untagged images 14 days after their push"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 14 }
        action       = { type = "expire" }
      },
    ]
  })
}
