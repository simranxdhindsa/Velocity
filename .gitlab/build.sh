#!/bin/sh

echo "Login to ECR Repository"
echo "Preparation task"
echo "Build Docker Image"
aws configure
docker build \
  --build-arg DEPLOYMENT_ID=${CI_PIPELINE_ID} \
  --build-arg VITE_GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID} \
  --build-arg VITE_API_URL=/api \
  -t $DOCKER_REGISTRY/$REPO:$PREFIX-$CI_PIPELINE_ID \
  -f Dockerfile .
echo "Push to ECR Repository"
aws ecr get-login-password | docker login --username AWS --password-stdin $DOCKER_REGISTRY
docker push $DOCKER_REGISTRY/$REPO:$PREFIX-$CI_PIPELINE_ID