#!/bin/bash
set -e

# Script to build and push production Docker images to personal GHCR repository
# Repository: https://github.com/unplugged-kk/monize
#
# Usage:
#   ./scripts/build-push-ghcr.sh [REGISTRY_USER] [TAG]
# Example:
#   ./scripts/build-push-ghcr.sh unplugged-kk latest

USER_NAME=${1:-"unplugged-kk"}
REGISTRY="ghcr.io/${USER_NAME,,}" # Convert to lowercase for GHCR
TAG=${2:-"latest"}

echo "=========================================="
echo "  Building Monize Production Docker Images"
echo "  Target: ${REGISTRY}/monize-backend:${TAG}"
echo "  Target: ${REGISTRY}/monize-frontend:${TAG}"
echo "=========================================="

echo "Building Backend container..."
docker build -t ${REGISTRY}/monize-backend:${TAG} --target production -f backend/Dockerfile .

echo "Building Frontend container..."
docker build -t ${REGISTRY}/monize-frontend:${TAG} --target production ./frontend

echo "Pushing Backend image to GHCR..."
docker push ${REGISTRY}/monize-backend:${TAG}

echo "Pushing Frontend image to GHCR..."
docker push ${REGISTRY}/monize-frontend:${TAG}

echo ""
echo "✅ Successfully built and pushed images to GitHub Container Registry!"
echo "   ghcr.io/${USER_NAME}/monize-backend:${TAG}"
echo "   ghcr.io/${USER_NAME}/monize-frontend:${TAG}"
