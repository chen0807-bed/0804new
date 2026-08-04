# MLB Trade Value External Proxy API

This folder contains a Cloudflare Worker that proxies and normalizes data for the MLB trade value website.

## Routes

- `GET /api/health`
- `GET /api/tjstats?q=Aaron%20Judge`
- `GET /api/savant?start=2026-07-01&end=2026-08-02&team=LAD`
- `GET /api/savant?start=2026-07-01&end=2026-08-02&team=LAD&playerType=pitcher`
- `GET /api/prospects?teamId=119`
- `GET /api/player-search?q=Shohei%20Ohtani`

## Deploy With Cloudflare Workers

1. Copy `wrangler.toml.example` to `wrangler.toml`.
2. Run `npm create cloudflare@latest` or install Wrangler in your own environment.
3. Deploy this folder with:

```powershell
npx wrangler deploy
```

After deployment, copy the Worker URL, for example:

```text
https://mlb-trade-value-proxy.<your-subdomain>.workers.dev
```

Then paste that URL into the website's external API URL field.

## Notes

TJStats parsing only reads public player pages and public search results. Member-only pages are not accessed. Baseball Savant, TJStats, and MLB endpoints can change or rate-limit requests. The Worker returns JSON with CORS enabled so the website can call it from any public URL.
