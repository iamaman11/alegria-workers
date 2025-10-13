# Remove API Token
$env:CLOUDFLARE_API_TOKEN = $null

# Set Global API Key
$env:CLOUDFLARE_EMAIL = "majakojh@gmail.com"
$env:CLOUDFLARE_API_KEY = "62160ad0e9c5ad0e3ebdf7c73e183c08bb43f"

# Test authentication
Write-Host "Testing authentication with Global API Key..."
wrangler whoami

# Test Pages access
Write-Host "`nTesting Pages API access..."
wrangler pages project list
