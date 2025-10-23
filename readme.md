# Cloudflare Workers API - Alegria

Production API endpoints serving the Alegria CMS platform.

## URLs

- **Primary:** `https://api.poshta.cloud`
- **Fallback:** `https://alegria-api.majakojh.workers.dev`

## Architecture

```
Frontend (Pages) → api.poshta.cloud → Workers → CMS
     poshta.cloud        (CNAME)    (Hono.js)
```

## Key Features

- **3-Layer Caching:** CDN → KV → D1
- **Media Storage:** Cloudflare R2 (S3-compatible)
- **Query Optimization:** Efficient caching strategies
- **ISR Support:** Pre-warming for instant page updates

## Deployment

```bash
npx wrangler deploy
```

Routes are configured in `wrangler.toml`:
- Pattern: `api.poshta.cloud/*`
- Zone: `poshta.cloud`

## Environment

See `wrangler.toml` for [vars] and environment configuration.

## Documentation

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Token Guide](../docs/Token-CLOUDFLARE_AUTH_GUIDE.md)
- [Deployment Guide](../docs/deployment-WORKERS.md)

---

**Last Updated:** 2025-10-18
