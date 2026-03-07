REGISTRY=registry.ucdialplans.com/monize
docker build -t $REGISTRY/backend:latest --target production -f backend/Dockerfile . && docker push $REGISTRY/backend:latest
docker build -t $REGISTRY/frontend:latest --target production ./frontend && docker push $REGISTRY/frontend:latest

# Manual code scanners
```
docker run --rm -v ~/monize:/tmp/scan bearer/bearer:latest-amd64 scan /tmp/scan --skip-rule=[javascript_lang_logger_leak,javascript_express_https_protocol_missing]
```
