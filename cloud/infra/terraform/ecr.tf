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
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the newest 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}
