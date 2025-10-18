# Remove API Token environment variable
Remove-Item Env:\CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue

# Set Global API Key
$env:CLOUDFLARE_EMAIL = "majakojh@gmail.com"
$env:CLOUDFLARE_API_KEY = "62160ad0e9c5ad0e3ebdf7c73e183c08bb43f"

Write-Host "[INFO] Testing authentication with Global API Key..."
npx wrangler whoami

Write-Host "`n[INFO] Deploying Worker with routes (poshta.cloud/api/*)..."
npx wrangler deploy

Write-Host "`n[OK] Deployment completed successfully!"
Write-Host "`n[INFO] Worker available at:"
Write-Host "  - https://alegria-api.majakojh.workers.dev"
Write-Host "  - https://poshta.cloud/api/*"
