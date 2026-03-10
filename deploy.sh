#!/bin/sh
# This script builds and deploys the Monize backend and frontend to my private Kubernetes registry
# then restarts the Monize pods to use the new images.

set -e

REGISTRY=registry.ucdialplans.com/monize

cd ~/monize
echo "Building backend..."
docker build -t $REGISTRY/backend:latest --target production -f backend/Dockerfile .
echo "Pushing backend..."
docker push $REGISTRY/backend:latest

echo "Building frontend..."
docker build -t $REGISTRY/frontend:latest --target production ./frontend
echo "Pushing frontend..."
docker push $REGISTRY/frontend:latest

echo "Restarting pods..."
kubectl delete -n monize pod monize-backend-0 monize-frontend-0

echo "Done. Pods will restart automatically."
