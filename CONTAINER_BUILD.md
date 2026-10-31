# In-cluster build (home cluster)
The `monize-build` CronJob in the `monize` namespace builds and deploys without
Docker on this machine. It clones a branch (`main` by default), builds both
`production` images with Kaniko, pushes them to
`registry.laskonet.com/monize/{backend,frontend}:latest` and runs
`kubectl rollout restart` on both deployments. It is suspended, so it runs only
when triggered by hand:

```
kubectl create job -n monize --from=cronjob/monize-build monize-build-$(date +%s)   # main
scripts/monize-build.sh my-branch    # from a k8s repo checkout: any branch, follows the logs
```

Both builds cache their `RUN` layers in the registry, so `npm ci` re-runs only
when a `package*.json` changes. The registry's `registry-prune-cache` CronJob
deletes cache layers older than 14 days every Sunday. The manifests and details
are in the k8s repo:
[cronjob-build.yaml](https://github.com/kenlasko/k8s/blob/main/manifests/apps/monize/overlays/home/cronjob-build.yaml),
[monize-build.sh](https://github.com/kenlasko/k8s/blob/main/scripts/monize-build.sh)
and the [Monize README](https://github.com/kenlasko/k8s/blob/main/manifests/apps/monize/README.md).

# Local build
The workloads are Deployments, so the pods have generated names
(`monize-backend-<replicaset>-<random>`) rather than the ordinal
`monize-backend-0` a StatefulSet gave them. `kubectl rollout restart` names the
workload instead of a pod, which is both stable and the only form that restarts
every replica at `cluster.mode: multi`.

```
cd ~/monize && REGISTRY=registry.laskonet.com/monize
docker build -t $REGISTRY/backend:latest --target production -f backend/Dockerfile . && docker push $REGISTRY/backend:latest && kubectl rollout restart deployment/monize-backend -n monize
docker build -t $REGISTRY/frontend:latest --target production ./frontend && docker push $REGISTRY/frontend:latest && kubectl rollout restart deployment/monize-frontend -n monize
```

# Manual code scanners
```
docker run --rm -v ~/monize:/tmp/scan bearer/bearer:latest-amd64 scan /tmp/scan --skip-rule=[javascript_lang_logger_leak,javascript_express_https_protocol_missing]
```
