# Remove API Token environment variable
Remove-Item Env:\CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue

# Set Global API Key
$env:CLOUDFLARE_EMAIL = "majakojh@gmail.com"
$env:CLOUDFLARE_API_KEY = "62160ad0e9c5ad0e3ebdf7c73e183c08bb43f"

Write-Host "[INFO] Testing authentication with Global API Key..."
npx wrangler whoami

Write-Host "`n[INFO] Deploying Worker with routes..."
npx wrangler deploy

Write-Host "`n[OK] Deployment completed"
