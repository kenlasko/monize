```
cd ~/monize && REGISTRY=registry.ucdialplans.com/monize
docker build -t $REGISTRY/backend:latest --target production -f backend/Dockerfile . && docker push $REGISTRY/backend:latest && kubectl delete pod -n monize monize-backend-0
docker build -t $REGISTRY/frontend:latest --target production ./frontend && docker push $REGISTRY/frontend:latest && kubectl delete pod -n monize monize-frontend-0
```

# Manual code scanners
```
docker run --rm -v ~/monize:/tmp/scan bearer/bearer:latest-amd64 scan /tmp/scan --skip-rule=[javascript_lang_logger_leak,javascript_express_https_protocol_missing]
```
