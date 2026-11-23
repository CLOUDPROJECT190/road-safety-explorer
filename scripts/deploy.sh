#!/usr/bin/env bash
# One-command deployment (run in Azure Cloud Shell or any shell with az, node, zip).
#
#   ./scripts/deploy.sh                 # deploy everything
#   RG=my-rg LOCATION=norwayeast ./scripts/deploy.sh
#   FRONTEND=staticWebApp ./scripts/deploy.sh   # host the UI on Static Web Apps instead of Storage
#   ./scripts/deploy.sh --web-only      # rebuild and upload the front end only
#   ./scripts/deploy.sh --destroy       # delete the resource group and everything in it
#
# Steps: resource group -> Bicep -> function code -> front end -> smoke test.
set -euo pipefail

RG="${RG:-rg-road-safety-explorer}"
LOCATION="${LOCATION:-uksouth}"
FRONTEND="${FRONTEND:-storage}"   # storage | staticWebApp
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--destroy" ]]; then
  echo "Deleting resource group $RG ..."
  az group delete --name "$RG" --yes
  exit 0
fi

echo "Subscription: $(az account show --query '[name, id]' -o tsv | tr '\t' ' ')"
echo "Resource group: $RG ($LOCATION)"

out() { az deployment group show -g "$RG" -n road-safety-explorer --query "properties.outputs.$1.value" -o tsv; }

if [[ "${1:-}" != "--web-only" ]]; then
echo "== 1/5 Resource providers and resource group"
for ns in Microsoft.Web Microsoft.Storage Microsoft.Insights Microsoft.OperationalInsights; do
  if [[ "$(az provider show -n "$ns" --query registrationState -o tsv)" != "Registered" ]]; then
    echo "   registering $ns"
    az provider register -n "$ns" --wait
  fi
done
az group create --name "$RG" --location "$LOCATION" --output none

echo "== 2/5 Infrastructure (Bicep)"
az deployment group create \
  --resource-group "$RG" \
  --name road-safety-explorer \
  --template-file "$ROOT/infra/main.bicep" \
  --parameters frontend="$FRONTEND" \
  --output none
fi
FUNC_NAME="$(out functionAppName)"
FUNC_URL="$(out functionAppUrl)"
SWA_NAME="$(out staticWebAppName)"
WEB_URL="$(out webUrl)"
STORAGE="$(out storageAccountName)"

if [[ "${1:-}" != "--web-only" ]]; then
echo "== 3/5 Function app code -> $FUNC_NAME"
PKG="$(mktemp -d)/api.zip"
(cd "$ROOT/api" && zip -qr "$PKG" . -x 'local.settings.json' -x '*__pycache__*' -x '.venv/*' -x '.python_packages/*')
az functionapp deployment source config-zip \
  --resource-group "$RG" --name "$FUNC_NAME" --src "$PKG" --build-remote true --output none
fi

echo "== 4/5 Front end ($FRONTEND)"
(cd "$ROOT/web" && npm ci --include=dev --no-audit --no-fund --silent && NODE_ENV=production VITE_API_BASE="$FUNC_URL" npm run build --silent)
if [[ "$FRONTEND" == "staticWebApp" ]]; then
  SWA_TOKEN="$(az staticwebapp secrets list --name "$SWA_NAME" --resource-group "$RG" --query properties.apiKey -o tsv)"
  npx --yes @azure/static-web-apps-cli deploy "$ROOT/web/dist" --deployment-token "$SWA_TOKEN" --env production
else
  KEY="$(az storage account keys list --account-name "$STORAGE" --resource-group "$RG" --query '[0].value' -o tsv)"
  az storage blob service-properties update --account-name "$STORAGE" --account-key "$KEY" \
    --static-website --index-document index.html --404-document index.html --output none
  az storage blob delete-batch --account-name "$STORAGE" --account-key "$KEY" --source '$web' --output none
  az storage blob upload-batch --account-name "$STORAGE" --account-key "$KEY" \
    --destination '$web' --source "$ROOT/web/dist" --overwrite --output none
fi

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
  Web app : $WEB_URL
  API     : $FUNC_URL/api
  Benchmark: python3 scripts/benchmark.py --api $FUNC_URL --years 2023 --runs 5
  Tear down: ./scripts/deploy.sh --destroy
EOF
