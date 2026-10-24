# Sourced by the deploy scripts: every kubectl call goes to mike-gke, whatever
# the shell's current context is (other sessions on this machine switch it).
# Override with KUBE_CONTEXT. Never `kubectl config use-context` from here.
KUBE_CONTEXT="${KUBE_CONTEXT:-gke_ari-teste-492120_southamerica-east1_mike-gke}"
kubectl() { command kubectl --context "$KUBE_CONTEXT" "$@"; }
export -f kubectl 2>/dev/null || true
export KUBE_CONTEXT
