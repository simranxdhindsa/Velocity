#!/bin/sh
set -eu

: "${DOCKER_REGISTRY:?DOCKER_REGISTRY is required}"
: "${REPO:?REPO is required}"
: "${PREFIX:?PREFIX is required}"
: "${CI_PIPELINE_ID:?CI_PIPELINE_ID is required}"
: "${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION is required}"

image="$DOCKER_REGISTRY/$REPO:$PREFIX-$CI_PIPELINE_ID"
cache_image="$DOCKER_REGISTRY/$REPO:$PREFIX-buildcache"
builder="velocity-${CI_JOB_ID:-$CI_PIPELINE_ID}"

# Use the official AWS CLI container instead of installing tools on every job.
# Pass credentials by environment name so their values never appear in argv.
# Capture first: a failed AWS command must stop the job before docker login.
echo "Authenticate to ECR"
ecr_password=$(docker run --rm \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
  -e AWS_DEFAULT_REGION -e AWS_REGION -e AWS_EC2_METADATA_DISABLED \
  "${AWS_CLI_IMAGE:-public.ecr.aws/aws-cli/aws-cli:2.24.18}" \
  ecr get-login-password --region "$AWS_DEFAULT_REGION")
printf '%s' "$ecr_password" | docker login --username AWS --password-stdin "$DOCKER_REGISTRY"
unset ecr_password

# The container driver supports registry cache on runners without the Docker
# containerd image store. Only clean up this job's builder, never the daemon.
docker buildx create --name "$builder" --driver docker-container --use
trap 'docker buildx rm "$builder" >/dev/null 2>&1 || true' EXIT

echo "Build and push $image"
docker buildx build \
  --builder "$builder" \
  --platform linux/amd64 \
  --progress plain \
  --cache-from "type=registry,ref=$cache_image" \
  --cache-to "type=registry,ref=$cache_image,mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true" \
  --build-arg "VITE_GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}" \
  --build-arg VITE_API_URL=/api \
  --tag "$image" \
  --push \
  -f Dockerfile .
