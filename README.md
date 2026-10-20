# website-publisher

Drop a folder, get a website. A small self-hosted static site publisher with a Czech UI:

- **Upload page** (`/`): drag & drop a folder (or a `.zip`) and it is live as soon as the upload finishes.
- **Admin panel** (`/admin`): list, rename and delete sites. Protected by `ADMIN_PASSWORD` from `.env`.
- **Guide** (`/docs`): how to publish, for whoever uses it.
- Each site gets its own subdomain, e.g. `https://<name>.freepages.dev/`, or without `SITE_DOMAIN` a path, `PUBLIC_URL/<name>/`.
- Everything is stored in one Docker volume (`/data`). There is no database.

## Quick start (Docker Compose)

```bash
cp .env.example .env        # set ADMIN_PASSWORD (and PUBLIC_URL / SITE_DOMAIN)
docker compose up -d --build
```

Open http://localhost:3000, log in with the password and drop a folder.

Data lives in the `publisher-data` volume:

```
/data/sites/<name>/   published files
/data/meta/<name>.json
/data/.session-secret
```

Back up that volume and you have backed up everything.

### Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_PASSWORD` | required | Password for publishing and `/admin`. Changing it logs everyone out. |
| `PUBLIC_URL` | `http://localhost:3000` | Address of the publisher as the browser sees it, e.g. `https://freepages.dev`. Secure cookies are enabled when it starts with `https`. |
| `SITE_DOMAIN` | empty | Empty: sites live at `PUBLIC_URL/<name>/`. Set to `freepages.dev`: sites live at `https://<name>.freepages.dev/` and the path URLs redirect there. |
| `PUBLIC_UPLOAD` | `false` | `true` lets anyone publish without a password (they can't replace existing sites). |
| `MAX_UPLOAD_MB` | `100` | Upload limit. Cloudflare Free/Pro rejects request bodies over 100 MB anyway. |
| `PATH_SANDBOX` | `true` | Serve path-style sites with a CSP sandbox (see Security). |

## Deploying with Cloudflare Tunnel

The setup used here: the publisher runs on `https://freepages.dev` and every site gets its own subdomain, `https://<name>.freepages.dev/`. `www.freepages.dev` redirects to the publisher. Cloudflare's free Universal SSL covers both `freepages.dev` and `*.freepages.dev`.

1. **Zone**: `freepages.dev` must be an active zone in your Cloudflare account, with the Universal SSL certificate showing **Active** (SSL/TLS → Edge Certificates).
2. **Tunnel**: in Zero Trust → Networks → Tunnels → your tunnel → **Public hostnames**, add two hostnames with the same service:

   | Subdomain | Domain | Service |
   | --- | --- | --- |
   | *(empty)* | `freepages.dev` | `HTTP` → `publisher:3000` |
   | `*` | `freepages.dev` | `HTTP` → `publisher:3000` |

   Use `publisher:3000` when cloudflared runs in the same compose project. With Dokploy use Traefik instead: `dokploy-traefik:80` if cloudflared runs on `dokploy-network`, or `localhost:80` if it runs on the host.
3. **DNS**: check that the zone has `*` → `CNAME` → `<tunnel-id>.cfargotunnel.com`, **Proxied**. The dashboard often doesn't create the wildcard record; add it by hand if it's missing. The tunnel ID is on the tunnel's overview page.
4. **`.env`**: `PUBLIC_URL=https://freepages.dev`, `SITE_DOMAIN=freepages.dev`.

Path-style links (`freepages.dev/<name>/`) redirect to the subdomain. To use another domain, change `PUBLIC_URL`, `SITE_DOMAIN`, the tunnel hostnames and (on Dokploy) the Traefik rule. Keep to one level of subdomains: a two-level wildcard like `*.pub.example.com` needs Cloudflare's paid Advanced Certificate Manager.

Without `SITE_DOMAIN` everything runs on a single hostname and sites live at `PUBLIC_URL/<name>/`. Then you only need the one tunnel hostname, but sites run sandboxed (see Security).

### Running cloudflared next to the app (plain Compose)

```bash
# .env: TUNNEL_TOKEN=... (from the Zero Trust dashboard)
docker compose --profile tunnel up -d --build
```

Point the tunnel's public hostnames at `http://publisher:3000`.

## Deploying on Dokploy

1. Create a **Compose** service from this repo and set **Compose Path** to `./docker-compose.dokploy.yml`.
2. In **Environment** set `ADMIN_PASSWORD`, `PUBLIC_URL=https://freepages.dev`, `SITE_DOMAIN=freepages.dev`.
3. Deploy. Routing is done by the Traefik labels in the compose file, not the Domains tab, because they include the wildcard rule:
   ```
   Host(`freepages.dev`) || HostRegexp(`^[a-z0-9-]+\.freepages\.dev$`)
   ```
   If you use other domains, edit that line.
4. Point the Cloudflare Tunnel hostnames (`freepages.dev` and `*.freepages.dev`) at Dokploy's Traefik over plain HTTP: `http://localhost:80` if cloudflared runs on the host, or `http://dokploy-traefik:80` if it runs in Docker on `dokploy-network`. Cloudflare terminates TLS, so the router uses the `web` (HTTP) entrypoint.

## Security notes

- Uploaded sites can contain arbitrary JavaScript. With subdomains each site has its own origin, so it is isolated from the admin panel. In path mode, sites share the admin's origin, so they are served with a CSP `sandbox` (opaque origin). Their scripts can't use your session, but they also can't use `localStorage` or cookies. Prefer subdomain mode if your sites need those.
- State-changing API calls require a custom header plus a matching `Origin`, and the session cookie is `HttpOnly; SameSite=Strict`.
- Login is rate-limited to 10 failures per IP per 15 minutes.
- Upload paths are sanitized (`..` is rejected), zip extraction counts uncompressed bytes against the limit, and a publish swaps directories atomically.

## Development

```bash
npm install
npm run dev     # ADMIN_PASSWORD=dev, data in ./data, http://localhost:3000
```
