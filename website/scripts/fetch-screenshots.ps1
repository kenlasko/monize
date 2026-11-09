# Downloads every screenshot the site uses into assets\img\screenshots\
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File scripts\fetch-screenshots.ps1
$base = "https://raw.githubusercontent.com/wiki/kenlasko/monize/images"
$out  = Join-Path $PSScriptRoot "..\assets\img\screenshots"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$names = @(
  "2fa-setup",
  "account-reconciliation",
  "accounts-list",
  "admin-user-management",
  "ai-chat",
  "ai-settings",
  "bills-deposits-page",
  "bills-list",
  "cash-flow-forecast",
  "create-account-form",
  "currencies-page",
  "custom-report-builder",
  "dashboard-expenses-pie",
  "dashboard-income-expenses-bar",
  "dashboard-net-worth",
  "dashboard-top-movers",
  "dashboard-upcoming-bills",
  "import-complete-step",
  "import-create-account",
  "import-map-accounts",
  "import-map-categories",
  "import-map-securities",
  "import-review-step",
  "import-select-account",
  "import-upload-step",
  "investment-transaction-form",
  "investments-page",
  "oidc-login",
  "portfolio-holdings",
  "report-chart-table",
  "report-income-expenses",
  "report-net-worth",
  "report-spending-category",
  "reports-page",
  "scheduled-transaction-form",
  "securities-list",
  "settings-page",
  "split-transaction",
  "tags-page",
  "transaction-filters",
  "transaction-form",
  "transactions-page",
  "trusted-devices"
)
foreach ($n in $names) {
  Write-Host "-> $n.png"
  try { Invoke-WebRequest -Uri "$base/$n.png" -OutFile (Join-Path $out "$n.png") -UseBasicParsing }
  catch { Write-Host "   (missing, site will fall back to the wiki URL)" }
}
Write-Host "Done."
