#!/usr/bin/env bash
# Downloads every screenshot the site uses into assets/img/screenshots/
# so the site serves its own images instead of hot-linking the GitHub wiki.
set -euo pipefail
BASE="https://raw.githubusercontent.com/wiki/kenlasko/monize/images"
OUT="$(dirname "$0")/../assets/img/screenshots"
mkdir -p "$OUT"
for n in \
  2fa-setup \
  account-reconciliation \
  accounts-list \
  admin-user-management \
  ai-chat \
  ai-settings \
  bills-deposits-page \
  bills-list \
  cash-flow-forecast \
  create-account-form \
  currencies-page \
  custom-report-builder \
  dashboard-expenses-pie \
  dashboard-income-expenses-bar \
  dashboard-net-worth \
  dashboard-top-movers \
  dashboard-upcoming-bills \
  import-complete-step \
  import-create-account \
  import-map-accounts \
  import-map-categories \
  import-map-securities \
  import-review-step \
  import-select-account \
  import-upload-step \
  investment-transaction-form \
  investments-page \
  oidc-login \
  portfolio-holdings \
  report-chart-table \
  report-income-expenses \
  report-net-worth \
  report-spending-category \
  reports-page \
  scheduled-transaction-form \
  securities-list \
  settings-page \
  split-transaction \
  tags-page \
  transaction-filters \
  transaction-form \
  transactions-page \
  trusted-devices;
do
  echo "-> $n.png"
  curl -fsSL "$BASE/$n.png" -o "$OUT/$n.png" || echo "   (missing, site will fall back to the wiki URL)"
done
curl -fsSL "https://raw.githubusercontent.com/kenlasko/monize/main/frontend/public/icons/monize-logo.svg" -o "$(dirname "$0")/../assets/img/monize-logo.svg"
echo "Done. $(ls -1 "$OUT" | wc -l) files in assets/img/screenshots/"
