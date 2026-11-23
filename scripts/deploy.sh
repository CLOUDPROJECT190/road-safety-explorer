#!/usr/bin/env bash
# One-command deployment (run in Azure Cloud Shell or any shell with az, node, zip).
#
#   ./scripts/deploy.sh                 # deploy everything
#   RG=my-rg LOCATION=uksouth ./scripts/deploy.sh
#   ./scripts/deploy.sh --destroy       # delete the resource group and everything in it
#
# Steps: resource group -> Bicep -> function code -> front end -> smoke test.
set -euo pipefail

RG="${RG:-rg-road-safety-explorer}"
LOCATION="${LOCATION:-uksouth}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--destroy" ]]; then
  echo "Deleting resource group $RG ..."
  az group delete --name "$RG" --yes
  exit 0
fi

echo "Subscription: $(az account show --query '[name, id]' -o tsv | tr '\t' ' ')"
echo "Resource group: $RG ($LOCATION)"

echo "== 1/5 Resource group"
az group create --name "$RG" --location "$LOCATION" --output none

echo "== 2/5 Infrastructure (Bicep)"
az deployment group create \
  --resource-group "$RG" \
  --name road-safety-explorer \
  --template-file "$ROOT/infra/main.bicep" \
  --output none
out() { az deployment group show -g "$RG" -n road-safety-explorer --query "properties.outputs.$1.value" -o tsv; }
FUNC_NAME="$(out functionAppName)"
FUNC_URL="$(out functionAppUrl)"
SWA_NAME="$(out staticWebAppName)"
SWA_URL="$(out staticWebAppUrl)"

echo "== 3/5 Function app code -> $FUNC_NAME"
PKG="$(mktemp -d)/api.zip"
(cd "$ROOT/api" && zip -qr "$PKG" . -x 'local.settings.json' -x '*__pycache__*' -x '.venv/*' -x '.python_packages/*')
az functionapp deployment source config-zip \
  --resource-group "$RG" --name "$FUNC_NAME" --src "$PKG" --build-remote true --output none

echo "== 4/5 Front end -> $SWA_NAME"
(cd "$ROOT/web" && npm ci --no-audit --no-fund --silent && VITE_API_BASE="$FUNC_URL" npm run build --silent)
SWA_TOKEN="$(az staticwebapp secrets list --name "$SWA_NAME" --resource-group "$RG" --query properties.apiKey -o tsv)"
npx --yes @azure/static-web-apps-cli deploy "$ROOT/web/dist" --deployment-token "$SWA_TOKEN" --env production

echo "== 5/5 Smoke test"
for i in $(seq 1 20); do
  if curl -fsS -m 20 "$FUNC_URL/api/meta" >/dev/null 2>&1; then
    echo "API is responding."
    break
  fi
  [[ $i == 20 ]] && { echo "API did not respond at $FUNC_URL/api/meta" >&2; exit 1; }
  sleep 6
done

cat <<EOF

Deployed.
  Web app : $SWA_URL
  API     : $FUNC_URL/api
  Benchmark: python3 scripts/benchmark.py --api $FUNC_URL --years 2023 --runs 5
  Tear down: ./scripts/deploy.sh --destroy
EOF
