import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { cache } from 'hono/cache';

type Bindings = {
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
  CACHE: KVNamespace;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS: string;
  CMS_URL: string;
  FRONTEND_URL: string;
  VERCEL_BYPASS_TOKEN?: string;
  WEBHOOK_SECRET?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ZONE_ID?: string;
  WORKERS_DOMAIN?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// CORS configuration
app.use('*', async (c, next) => {
  const corsMiddleware = cors({
    origin: (origin) => {
      const allowedOrigins = c.env.ALLOWED_ORIGINS?.split(',') || [];
      return allowedOrigins.some(allowed =>
        origin.includes(allowed.replace('https://*.', ''))
      ) ? origin : false;
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-webhook-secret', 'x-request-id'],
  });
  return corsMiddleware(c, next);
});

/**
 * 3-LAYER EXPERT CACHING ARCHITECTURE
 *
 * Layer 1: Cloudflare CDN (Cache API) - Fastest, edge cache
 *   - 10-20ms response time
 *   - TTL: 300-1200s based on content type
 *   - Global purge via Cloudflare API on webhook
 *
 * Layer 2: Workers KV - Persistent fallback
 *   - ~50ms response time (hot read)
 *   - TTL: 600-3600s (longer than CDN)
 *   - Cleared on webhook
 *
 * Layer 3: Origin (Vercel CMS) - Source of truth
 *   - 200-500ms response time
 *   - Fetched only on cache miss
 *   - Data stored in both KV and CDN
 */
async function fetchFromCMS(
  c: any,
  endpoint: string,
  kvKey: string,
  kvTTL: number = 3600,
  cdnTTL: number = 1800,
  cacheTag?: string
): Promise<Response> {
  const startTime = Date.now();

  try {
    // LAYER 1: Check Cloudflare CDN Cache API
    const cache = caches.default;
    const cacheUrl = new URL(c.req.url);
    // CRITICAL: Cache key must NOT include request headers
    // so webhook can delete it with just the URL
    const cacheKey = new Request(cacheUrl.toString(), {
      method: 'GET',
    });

    let response = await cache.match(cacheKey);

    if (response) {
      const duration = Date.now() - startTime;
      console.log(`[Cache] CDN HIT in ${duration}ms: ${kvKey}`);

      // Clone and add cache hit header
      const headers = new Headers(response.headers);
      headers.set('X-Cache', 'CDN-HIT');
      headers.set('X-Cache-Duration', `${duration}ms`);

      return new Response(response.body, {
        status: response.status,
        headers,
      });
    }

    console.log(`[Cache] CDN MISS: ${kvKey}`);

    // LAYER 2: Check Workers KV
    const kvCached = await c.env.CACHE.get(kvKey);

    if (kvCached) {
      const duration = Date.now() - startTime;
      console.log(`[Cache] KV HIT in ${duration}ms: ${kvKey}`);

      // Create response from KV data
      const kvHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Cache': 'KV-HIT',
        'X-Cache-Duration': `${duration}ms`,
        'Cloudflare-CDN-Cache-Control': `public, max-age=${cdnTTL}`,
        'Vary': 'Accept-Encoding',
      };

      // Add Cache-Tag if provided
      if (cacheTag) {
        kvHeaders['Cache-Tag'] = cacheTag;
      }

      const kvResponse = new Response(kvCached, {
        status: 200,
        headers: kvHeaders,
      });

      // Store in CDN Cache for next request
      await cache.put(cacheKey, kvResponse.clone());

      return kvResponse;
    }

    console.log(`[Cache] KV MISS: ${kvKey}`);

    // LAYER 3: Fetch from Origin (Vercel CMS)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (c.env.VERCEL_BYPASS_TOKEN) {
      headers['x-vercel-protection-bypass'] = c.env.VERCEL_BYPASS_TOKEN;
    }

    const url = `${c.env.CMS_URL}${endpoint}`;
    console.log(`[Fetch] Origin: ${url}`);

    const originResponse = await fetch(url, { headers });

    if (!originResponse.ok) {
      throw new Error(`CMS returned ${originResponse.status}`);
    }

    const data = await originResponse.json();
    const dataString = JSON.stringify(data);

    // Store in KV (Layer 2) - longer TTL
    await c.env.CACHE.put(kvKey, dataString, {
      expirationTtl: kvTTL,
    });

    const duration = Date.now() - startTime;
    console.log(`[Fetch] Origin MISS in ${duration}ms: ${kvKey}`);

    // Create final response
    const finalHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Cache': 'ORIGIN-MISS',
      'X-Cache-Duration': `${duration}ms`,
      'Cloudflare-CDN-Cache-Control': `public, max-age=${cdnTTL}`,
      'Vary': 'Accept-Encoding',
    };

    // Add Cache-Tag if provided
    if (cacheTag) {
      finalHeaders['Cache-Tag'] = cacheTag;
    }

    const finalResponse = new Response(dataString, {
      status: 200,
      headers: finalHeaders,
    });

    // Store in CDN Cache (Layer 1) - shorter TTL
    await cache.put(cacheKey, finalResponse.clone());

    return finalResponse;
  } catch (error) {
    console.error('[Error] Fetch failed:', error);
    return c.json({ error: 'Failed to fetch from CMS' }, 500);
  }
}

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: c.env.ENVIRONMENT
  });
});

// ============================================
// POSTS API
// ============================================

// Get all posts (with pagination)
app.get('/api/posts', async (c) => {
  const page = c.req.query('page') || '1';
  const limit = c.req.query('limit') || '12';
  const depth = c.req.query('depth') || '1';
  const category = c.req.query('category');

  let endpoint = `/api/posts?page=${page}&limit=${limit}&depth=${depth}`;
  if (category) {
    endpoint += `&where[categories][in]=${category}`;
  }

  const kvKey = `posts:page=${page}:limit=${limit}:depth=${depth}:category=${category || 'all'}`;
  return fetchFromCMS(c, endpoint, kvKey, 600, 300); // KV: 10min, CDN: 5min
});

// Get single post by slug
app.get('/api/posts/:slug', async (c) => {
  const slug = c.req.param('slug');
  const depth = c.req.query('depth') || '2';
  const draft = c.req.query('draft') || 'false';

  const endpoint = `/api/posts?where[slug][equals]=${slug}&depth=${depth}&draft=${draft}&limit=1`;
  const kvKey = `post:${slug}:depth=${depth}:draft=${draft}`;

  const response = await fetchFromCMS(
    c,
    endpoint,
    kvKey,
    draft === 'true' ? 0 : 600, // KV: No cache for drafts, 10min for published
    draft === 'true' ? 0 : 300,  // CDN: No cache for drafts, 5min for published
    `post:${slug}`  // Cache-Tag for purging
  );

  // Extract first doc from paginated response
  if (response.status === 200) {
    const data = await response.json();
    if (data.docs && data.docs.length > 0) {
      return c.json(data.docs[0], 200, response.headers);
    }
    return c.json({ error: 'Post not found' }, 404);
  }

  return response;
});

// ============================================
// PAGES API
// ============================================

// Get all pages
app.get('/api/pages', async (c) => {
  const limit = c.req.query('limit') || '100';
  const depth = c.req.query('depth') || '1';

  const endpoint = `/api/pages?limit=${limit}&depth=${depth}`;
  const kvKey = `pages:limit=${limit}:depth=${depth}`;

  return fetchFromCMS(c, endpoint, kvKey, 1200, 600); // KV: 20min, CDN: 10min (rarely changes)
});

// Get single page by slug
app.get('/api/pages/:slug', async (c) => {
  const slug = c.req.param('slug');
  const depth = c.req.query('depth') || '2';
  const draft = c.req.query('draft') || 'false';

  const endpoint = `/api/pages?where[slug][equals]=${slug}&depth=${depth}&draft=${draft}&limit=1`;
  const kvKey = `page:${slug}:depth=${depth}:draft=${draft}`;

  const response = await fetchFromCMS(
    c,
    endpoint,
    kvKey,
    draft === 'true' ? 0 : 1200, // KV: No cache for drafts, 20min for published
    draft === 'true' ? 0 : 600,   // CDN: No cache for drafts, 10min for published
    `page:${slug}`  // Cache-Tag for purging
  );

  // Extract first doc from paginated response
  if (response.status === 200) {
    const data = await response.json();
    if (data.docs && data.docs.length > 0) {
      return c.json(data.docs[0], 200, response.headers);
    }
    return c.json({ error: 'Page not found' }, 404);
  }

  return response;
});

// ============================================
// CATEGORIES API
// ============================================

// Get all categories
app.get('/api/categories', async (c) => {
  const limit = c.req.query('limit') || '100';
  const endpoint = `/api/categories?limit=${limit}`;
  const kvKey = `categories:all:limit=${limit}`;

  return fetchFromCMS(c, endpoint, kvKey, 3600, 1800); // KV: 1hr, CDN: 30min (very rarely changes)
});

// Get single category by slug
app.get('/api/categories/:slug', async (c) => {
  const slug = c.req.param('slug');
  const endpoint = `/api/categories?where[slug][equals]=${slug}&limit=1`;
  const kvKey = `category:${slug}`;

  const response = await fetchFromCMS(c, endpoint, kvKey, 3600, 1800, `category:${slug}`); // Cache-Tag for purging

  // Extract first doc
  if (response.status === 200) {
    const data = await response.json();
    if (data.docs && data.docs.length > 0) {
      return c.json(data.docs[0], 200, response.headers);
    }
    return c.json({ error: 'Category not found' }, 404);
  }

  return response;
});

// ============================================
// MEDIA API
// ============================================

// Get single media by ID
app.get('/api/media/:id', async (c) => {
  const id = c.req.param('id');
  const endpoint = `/api/media/${id}`;
  const kvKey = `media:${id}`;

  return fetchFromCMS(c, endpoint, kvKey, 7200, 3600); // KV: 2hr, CDN: 1hr (static, immutable)
});

// ============================================
// GLOBALS API
// ============================================

// Get header global
app.get('/api/globals/header', async (c) => {
  const depth = c.req.query('depth') || '1';
  const endpoint = `/api/globals/header?depth=${depth}`;
  const kvKey = `global:header:depth=${depth}`;

  return fetchFromCMS(c, endpoint, kvKey, 3600, 1800, `global:header:${depth}`); // Cache-Tag for purging
});

// Get footer global
app.get('/api/globals/footer', async (c) => {
  const depth = c.req.query('depth') || '1';
  const endpoint = `/api/globals/footer?depth=${depth}`;
  const kvKey = `global:footer:depth=${depth}`;

  return fetchFromCMS(c, endpoint, kvKey, 3600, 1800, `global:footer:${depth}`); // Cache-Tag for purging
});

// ============================================
// REDIRECTS API
// ============================================

// Get all redirects
app.get('/api/redirects', async (c) => {
  const endpoint = '/api/redirects?limit=0';
  const kvKey = 'redirects:all';

  return fetchFromCMS(c, endpoint, kvKey, 3600, 1800); // KV: 1hr, CDN: 30min (very rarely changes)
});

// ============================================
// SEARCH API
// ============================================

// Search content
app.get('/api/search', async (c) => {
  const query = c.req.query('q') || '';
  const collections = c.req.query('collections') || 'posts';

  if (!query) {
    return c.json({ posts: { docs: [], totalDocs: 0 }, pages: { docs: [], totalDocs: 0 } });
  }

  const collectionList = collections.split(',');
  const results: any = {};

  for (const collection of collectionList) {
    const endpoint = `/api/${collection}?limit=12&where[or][0][title][like]=${encodeURIComponent(query)}&where[or][1][meta.description][like]=${encodeURIComponent(query)}`;
    const kvKey = `search:${collection}:${query}`;

    try {
      const response = await fetchFromCMS(c, endpoint, kvKey, 300, 180); // KV: 5min, CDN: 3min (search results)
      if (response.status === 200) {
        results[collection] = await response.json();
      }
    } catch (error) {
      console.error(`[Search] Failed for ${collection}:`, error);
      results[collection] = { docs: [], totalDocs: 0 };
    }
  }

  return c.json(results);
});

// ============================================
// CACHE MANAGEMENT
// ============================================

/**
 * EXPERT CACHE INVALIDATION STRATEGY
 *
 * When content is updated, we need to clear BOTH layers:
 * 1. Workers KV (easy - just delete keys)
 * 2. CDN Cache API (harder - need to delete specific URLs)
 *
 * The CDN Cache API is URL-based, so we construct all possible
 * URLs that might be cached for this content.
 */
async function clearCDNCacheForURLs(c: any, urls: string[]): Promise<number> {
  const cache = caches.default;
  let cleared = 0;

  for (const url of urls) {
    try {
      const cacheKey = new Request(url, { method: 'GET' });
      const deleted = await cache.delete(cacheKey);
      if (deleted) {
        cleared++;
        console.log(`[CDN Cache] Deleted: ${url}`);
      }
    } catch (error) {
      console.error(`[CDN Cache] Failed to delete ${url}:`, error);
    }
  }

  return cleared;
}

/**
 * Purge Cloudflare CDN cache by tags AND URLs using Cloudflare API
 * Tags: For Workers API cache (Cache-Tag headers)
 * URLs: For Pages cache (granular purge, works cross-zone)
 */
async function purgeCloudflare(c: any, tags: string[], urls: string[]): Promise<boolean> {
  // Check if API credentials are configured
  if (!c.env.CLOUDFLARE_API_TOKEN || !c.env.CLOUDFLARE_ZONE_ID) {
    console.warn('[Cloudflare API] API token or Zone ID not configured, skipping API purge');
    return false;
  }

  try {
    const body: { tags?: string[]; files?: string[] } = {};

    if (tags.length > 0) {
      body.tags = tags;
    }

    if (urls.length > 0) {
      body.files = urls;
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${c.env.CLOUDFLARE_ZONE_ID}/purge_cache`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${c.env.CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    const result = await response.json();

    if (response.ok && result.success) {
      console.log(`[Cloudflare API] Purged ${tags.length} tags and ${urls.length} URLs`);
      return true;
    } else {
      console.error('[Cloudflare API] Purge failed:', result);
      return false;
    }
  } catch (error) {
    console.error('[Cloudflare API] Error:', error);
    return false;
  }
}

// Invalidate cache endpoint (for webhooks)
app.post('/api/cache/invalidate', async (c) => {
  const startTime = Date.now();

  try {
    // Verify webhook secret
    const secret = c.req.header('x-webhook-secret');
    const requestId = c.req.header('x-request-id');

    console.log(`[Webhook] Request ${requestId || 'unknown'}: Received cache invalidation request`);

    if (!secret || secret !== c.env.WEBHOOK_SECRET) {
      console.error(`[Webhook] Request ${requestId || 'unknown'}: Unauthorized - Invalid secret`);
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const bodyData = await c.req.json();
    const { slug, collection, requestId: bodyRequestId, timestamp, operation } = bodyData;
    const finalRequestId = requestId || bodyRequestId || 'unknown';

    console.log(`[Webhook] Request ${finalRequestId}: Processing ${collection}:${slug} (operation: ${operation}, timestamp: ${timestamp})`);

    const deletedKVKeys: string[] = [];
    const cdnUrls: string[] = [];
    const workersDomain = c.env.WORKERS_DOMAIN || 'alegria-api.majakojh.workers.dev';
    const baseUrl = `https://${workersDomain}`;

    if (collection === 'posts') {
      // LAYER 2: Clear KV cache (all depth variations)
      for (const depth of ['1', '2']) {
        await c.env.CACHE.delete(`post:${slug}:depth=${depth}:draft=false`);
        await c.env.CACHE.delete(`post:${slug}:depth=${depth}:draft=true`);
      }
      deletedKVKeys.push(`post:${slug}:*`);

      // Clear posts list caches
      for (let i = 1; i <= 10; i++) {
        for (const depth of ['1', '2']) {
          await c.env.CACHE.delete(`posts:page=${i}:limit=12:depth=${depth}:category=all`);
        }
      }
      deletedKVKeys.push('posts:page=*');

      // LAYER 1: Build CDN Cache API URLs to clear
      // Single post URLs (all depth variations)
      for (const depth of ['1', '2']) {
        cdnUrls.push(`${baseUrl}/api/posts/${slug}?depth=${depth}`);
        cdnUrls.push(`${baseUrl}/api/posts/${slug}?depth=${depth}&draft=false`);
      }

      // Posts list URLs (first 3 pages, most likely to be cached)
      for (let i = 1; i <= 3; i++) {
        for (const depth of ['1', '2']) {
          cdnUrls.push(`${baseUrl}/api/posts?page=${i}&limit=12&depth=${depth}`);
        }
      }

      console.log(`[Webhook] Request ${finalRequestId}: Cleared KV keys for posts`);
    }

    if (collection === 'pages') {
      // LAYER 2: Clear KV cache
      for (const depth of ['1', '2']) {
        await c.env.CACHE.delete(`page:${slug}:depth=${depth}:draft=false`);
        await c.env.CACHE.delete(`page:${slug}:depth=${depth}:draft=true`);
      }
      deletedKVKeys.push(`page:${slug}:*`);

      for (const depth of ['1', '2']) {
        await c.env.CACHE.delete(`pages:limit=100:depth=${depth}`);
      }
      deletedKVKeys.push('pages:limit=*');

      // LAYER 1: CDN URLs
      for (const depth of ['1', '2']) {
        cdnUrls.push(`${baseUrl}/api/pages/${slug}?depth=${depth}`);
        cdnUrls.push(`${baseUrl}/api/pages/${slug}?depth=${depth}&draft=false`);
      }
      for (const depth of ['1', '2']) {
        cdnUrls.push(`${baseUrl}/api/pages?limit=100&depth=${depth}`);
      }

      console.log(`[Webhook] Request ${finalRequestId}: Cleared KV keys for pages`);
    }

    if (collection === 'categories') {
      // LAYER 2: KV
      await c.env.CACHE.delete(`category:${slug}`);
      await c.env.CACHE.delete('categories:all:limit=100');
      deletedKVKeys.push(`category:${slug}`, 'categories:all');

      // LAYER 1: CDN
      cdnUrls.push(`${baseUrl}/api/categories/${slug}`);
      cdnUrls.push(`${baseUrl}/api/categories?limit=100`);

      console.log(`[Webhook] Request ${finalRequestId}: Cleared KV keys for categories`);
    }

    if (collection === 'header' || collection === 'footer') {
      // LAYER 2: KV
      for (const depth of ['1', '2']) {
        await c.env.CACHE.delete(`global:${collection}:depth=${depth}`);
      }
      deletedKVKeys.push(`global:${collection}:*`);

      // LAYER 1: CDN
      for (const depth of ['1', '2']) {
        cdnUrls.push(`${baseUrl}/api/globals/${collection}?depth=${depth}`);
      }

      console.log(`[Webhook] Request ${finalRequestId}: Cleared KV keys for globals`);
    }

    if (collection === 'redirects') {
      // LAYER 2: KV
      await c.env.CACHE.delete('redirects:all');
      deletedKVKeys.push('redirects:all');

      // LAYER 1: CDN
      cdnUrls.push(`${baseUrl}/api/redirects?limit=0`);

      console.log(`[Webhook] Request ${finalRequestId}: Cleared KV keys for redirects`);
    }

    // Clear CDN Cache API (fallback method)
    const cdnCleared = await clearCDNCacheForURLs(c, cdnUrls);

    // Clear via Cloudflare API by tags (Workers API) and URLs (Pages)
    const cacheTags: string[] = [];
    const pagesUrls: string[] = [];
    const frontendDomain = c.env.FRONTEND_URL || 'https://poshta.cloud';

    if (collection === 'posts') {
      cacheTags.push(`post:${slug}`);
      // Purge Pages URLs for this post
      pagesUrls.push(`${frontendDomain}/posts/${slug}`);
      pagesUrls.push(`${frontendDomain}/posts`);  // posts list
    }

    if (collection === 'pages') {
      cacheTags.push(`page:${slug}`);
      // Purge Pages URLs
      if (slug === 'home') {
        pagesUrls.push(`${frontendDomain}/`);  // home page
      } else {
        pagesUrls.push(`${frontendDomain}/${slug}`);
      }
    }

    if (collection === 'categories') {
      cacheTags.push(`category:${slug}`);
      pagesUrls.push(`${frontendDomain}/categories/${slug}`);
      pagesUrls.push(`${frontendDomain}/posts`);  // posts list (shows categories)
    }

    if (collection === 'header') {
      cacheTags.push('global:header:1', 'global:header:2');
      // Header affects ALL pages - purge home page
      pagesUrls.push(`${frontendDomain}/`);
    }

    if (collection === 'footer') {
      cacheTags.push('global:footer:1', 'global:footer:2');
      // Footer affects ALL pages - purge home page
      pagesUrls.push(`${frontendDomain}/`);
    }

    const cfPurged = await purgeCloudflare(c, cacheTags, pagesUrls);

    // UNIVERSAL PRE-WARMING SYSTEM
    // Pre-warm published content after cache purge to rebuild ISR cache
    const COLLECTIONS_WITH_PAGES: Record<string, (slug: string) => string> = {
      pages: (slug: string) => slug === 'home' ? '/' : `/${slug}`,
      posts: (slug: string) => `/posts/${slug}`,
    };

    // Check if content should be pre-warmed (skip drafts, skip deletions)
    const shouldPreWarm =
      slug &&
      operation !== 'delete' &&
      collection in COLLECTIONS_WITH_PAGES &&
      (!('_status' in bodyData) || bodyData._status === 'published');

    if (shouldPreWarm) {
      const frontendUrl = c.env.FRONTEND_URL || 'https://poshta.cloud';  // FIXED: Was old Pages URL
      const pathGenerator = COLLECTIONS_WITH_PAGES[collection as keyof typeof COLLECTIONS_WITH_PAGES];
      const pageUrl = `${frontendUrl}${pathGenerator(slug)}`;

      console.log(`[Pre-warm] Request ${finalRequestId}: Initiating for ${collection}/${slug} (operation: ${operation}, status: ${bodyData._status || 'N/A'}) → ${pageUrl}`);

      // Pre-warm in background (non-blocking)
      c.executionCtx.waitUntil(
        fetch(pageUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Cloudflare-Workers-Prerender',
            'X-Prerender': 'true',
            'X-Request-Id': finalRequestId,
          },
          signal: AbortSignal.timeout(15000)
        })
        .then((res) => {
          if (res.ok) {
            const cacheStatus = res.headers.get('cf-cache-status') || 'unknown';
            const age = res.headers.get('age') || '0';
            console.log(`[Pre-warm] Request ${finalRequestId}: SUCCESS - ${pageUrl} (status: ${res.status}, cache: ${cacheStatus}, age: ${age}s)`);
          } else {
            console.warn(`[Pre-warm] Request ${finalRequestId}: NON-OK - ${pageUrl} (status: ${res.status}, error: ${res.statusText})`);
          }
          return res;
        })
        .catch((err) => {
          if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            console.error(`[Pre-warm] Request ${finalRequestId}: TIMEOUT - ${pageUrl} (exceeded 15s)`);
          } else {
            console.error(`[Pre-warm] Request ${finalRequestId}: FAILED - ${pageUrl}: ${err.message || String(err)}`);
          }
        })
      );
    }

    const duration = Date.now() - startTime;
    console.log(`[Webhook] Request ${finalRequestId}: SUCCESS - Cleared ${deletedKVKeys.length} KV keys, ${cdnCleared} CDN entries, CF API: ${cfPurged} (${cacheTags.length} tags, ${pagesUrls.length} URLs) in ${duration}ms`);

    return c.json({
      success: true,
      message: 'Cache invalidated (KV + CDN + Cloudflare API)',
      requestId: finalRequestId,
      slug,
      collection,
      deletedKVKeys,
      cdnUrlsCleared: cdnCleared,
      totalCdnUrls: cdnUrls.length,
      cloudflarePurged: cfPurged,
      cacheTags,
      pagesUrls,
      duration
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[Webhook] ERROR after ${duration}ms:`, error);
    return c.json({ error: 'Failed to invalidate cache' }, 500);
  }
});

// Manual cache purge endpoint (emergency use)
app.post('/api/cache/purge-all', async (c) => {
  const secret = c.req.header('x-webhook-secret');

  if (!secret || secret !== c.env.WEBHOOK_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const cache = caches.default;
    const workersDomain = c.env.WORKERS_DOMAIN || 'alegria-api.majakojh.workers.dev';
    const baseUrl = `https://${workersDomain}`;

    // List of all possible cached URLs
    const urlsToPurge = [
      // Pages
      `${baseUrl}/api/pages/home?depth=1`,
      `${baseUrl}/api/pages/home?depth=2`,
      `${baseUrl}/api/pages/home?depth=1&draft=false`,
      `${baseUrl}/api/pages/home?depth=2&draft=false`,
      `${baseUrl}/api/pages?limit=100&depth=1`,
      `${baseUrl}/api/pages?limit=100&depth=2`,
      // Globals
      `${baseUrl}/api/globals/header?depth=1`,
      `${baseUrl}/api/globals/header?depth=2`,
      `${baseUrl}/api/globals/footer?depth=1`,
      `${baseUrl}/api/globals/footer?depth=2`,
      // Redirects
      `${baseUrl}/api/redirects?limit=0`,
      // Posts (first 3 pages)
      `${baseUrl}/api/posts?page=1&limit=12&depth=1`,
      `${baseUrl}/api/posts?page=1&limit=12&depth=2`,
      `${baseUrl}/api/posts?page=2&limit=12&depth=1`,
      `${baseUrl}/api/posts?page=2&limit=12&depth=2`,
      `${baseUrl}/api/posts?page=3&limit=12&depth=1`,
      `${baseUrl}/api/posts?page=3&limit=12&depth=2`,
    ];

    let purged = 0;
    for (const url of urlsToPurge) {
      try {
        const deleted = await cache.delete(new Request(url, { method: 'GET' }));
        if (deleted) purged++;
      } catch (e) {
        console.error(`Failed to delete ${url}:`, e);
      }
    }

    // Also clear ALL KV keys
    const kvKeys = [
      'page:home:depth=1:draft=false',
      'page:home:depth=2:draft=false',
      'pages:limit=100:depth=1',
      'pages:limit=100:depth=2',
      'global:header:depth=1',
      'global:header:depth=2',
      'global:footer:depth=1',
      'global:footer:depth=2',
      'redirects:all',
    ];

    for (const key of kvKeys) {
      await c.env.CACHE.delete(key);
    }

    return c.json({
      success: true,
      message: 'All caches purged',
      cdnPurged: purged,
      cdnTotal: urlsToPurge.length,
      kvPurged: kvKeys.length,
    });
  } catch (error) {
    console.error('[Purge All] Error:', error);
    return c.json({ error: 'Failed to purge caches' }, 500);
  }
});

// ============================================
// MEDIA SERVING (R2)
// ============================================

// Serve media from R2 with Range support for video streaming
// Path format: /media/filename.jpg (generated by Payload CMS)
// R2 storage: files are in root without media/ prefix
app.get('/media/*', async (c) => {
  // Extract filename: /media/photo.jpg -> photo.jpg
  const key = c.req.path.replace('/media/', '');

  try {
    // Check if Range header is present (for video seeking)
    const range = c.req.header('Range');

    let object;
    let status = 200;
    const headers = new Headers();

    if (range) {
      // Parse Range header: "bytes=0-1023" or "bytes=1024-"
      const rangeMatch = range.match(/bytes=(\d+)-(\d*)/);

      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : undefined;

        // Get object with range
        object = await c.env.MEDIA_BUCKET.get(key, {
          range: end ? { offset: start, length: end - start + 1 } : { suffix: start },
        });

        if (object) {
          status = 206; // Partial Content
          const contentLength = end ? end - start + 1 : object.size - start;

          headers.set('Content-Range', `bytes ${start}-${end || object.size - 1}/${object.size}`);
          headers.set('Content-Length', contentLength.toString());
          headers.set('Accept-Ranges', 'bytes');
        }
      }
    } else {
      // Full file request
      object = await c.env.MEDIA_BUCKET.get(key);

      if (object) {
        headers.set('Content-Length', object.size.toString());
        headers.set('Accept-Ranges', 'bytes');
      }
    }

    if (!object) {
      return c.notFound();
    }

    // Set content type and cache headers
    object.httpMetadata?.contentType && headers.set('Content-Type', object.httpMetadata.contentType);

    // Video: cache for 1 year, immutable
    // Images: cache for 1 year, immutable
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');

    // CORS for video streaming from different domains
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Range');

    return new Response(object.body, { status, headers });
  } catch (error) {
    console.error('[Media] Fetch error:', error);
    return c.notFound();
  }
});

// ============================================
// DATABASE INITIALIZATION
// ============================================

// Initialize D1 tables
app.get('/api/init-db', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') {
    return c.json({ error: 'Only available in development' }, 403);
  }

  try {
    // Create page cache table
    await c.env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS page_cache (
        slug TEXT PRIMARY KEY,
        data TEXT,
        updated_at TEXT
      )
    `).run();

    // Create media table
    await c.env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS media (
        key TEXT PRIMARY KEY,
        filename TEXT,
        size INTEGER,
        content_type TEXT,
        uploaded_at TEXT
      )
    `).run();

    return c.json({ success: true, message: 'Database initialized' });
  } catch (error) {
    console.error('[DB] Init error:', error);
    return c.json({ error: 'Failed to initialize database' }, 500);
  }
});

export default app;
