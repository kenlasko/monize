REGISTRY=registry.ucdialplans.com/moneymate
docker build -t $REGISTRY/backend:latest --target production -f backend/Dockerfile . && docker push $REGISTRY/backend:latest
docker build -t $REGISTRY/frontend:latest --target production ./frontend && docker push $REGISTRY/frontend:latest