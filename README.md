# website-publisher

Drop a folder, get a website. A small self-hosted static site publisher with a Czech UI:

- **Upload page** (`/`): drag & drop a folder (or a `.zip`) and it is live as soon as the upload finishes.
- **Admin panel** (`/admin`): list, rename and delete sites. Protected by `ADMIN_PASSWORD` from `.env`.
- **Guide** (`/docs`): how to publish, for whoever uses it.
- Sites are served either as `https://pub.raixo.org/<name>/` or, with `SITE_DOMAIN`, on their own subdomain such as `https://<name>.freepages.dev/`.
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
| `PUBLIC_URL` | `http://localhost:3000` | Address of the publisher as the browser sees it, e.g. `https://pub.raixo.org`. Secure cookies are enabled when it starts with `https`. |
| `SITE_DOMAIN` | empty | Empty: sites live at `PUBLIC_URL/<name>/`. Set to `freepages.dev`: sites live at `https://<name>.freepages.dev/` and the path URLs redirect there. |
| `PUBLIC_UPLOAD` | `false` | `true` lets anyone publish without a password (they can't replace existing sites). |
| `MAX_UPLOAD_MB` | `100` | Upload limit. Cloudflare Free/Pro rejects request bodies over 100 MB anyway. |
| `PATH_SANDBOX` | `true` | Serve path-style sites with a CSP sandbox (see Security). |

## Deploying with Cloudflare Tunnel

### Option A: one domain, sites as paths (`pub.raixo.org/<name>/`)

Works with zero extra setup:

1. In Zero Trust → Networks → Tunnels → your tunnel → **Public hostnames**, add `pub.raixo.org` → `http://<host>:3000` (or the Dokploy Traefik, see below).
2. `.env`: `PUBLIC_URL=https://pub.raixo.org`, `SITE_DOMAIN=` (empty).

### Option B: a subdomain per site on a separate domain (`<name>.freepages.dev`)

The publisher stays on `pub.raixo.org`, and every site gets `https://<name>.freepages.dev/`. A separate domain is covered by Cloudflare's free certificate (apex + `*.freepages.dev`) and fully isolates uploaded sites from your other services. `freepages.dev` and `www.freepages.dev` redirect to the publisher.

1. **Zone**: `freepages.dev` must be an active zone in your Cloudflare account. If you bought it elsewhere, add it and switch the nameservers at the registrar. Wait until the Universal SSL certificate shows **Active** (SSL/TLS → Edge Certificates).
2. **Tunnel**: in Zero Trust → Networks → Tunnels → your tunnel → **Public hostnames**, add three hostnames, all with the same service:

   | Subdomain | Domain | Service |
   | --- | --- | --- |
   | `pub` | `raixo.org` | `HTTP` → `publisher:3000` |
   | *(empty)* | `freepages.dev` | `HTTP` → `publisher:3000` |
   | `*` | `freepages.dev` | `HTTP` → `publisher:3000` |

   Use `publisher:3000` when cloudflared runs in the same compose project. With Dokploy use Traefik instead: `dokploy-traefik:80` if cloudflared runs on `dokploy-network`, or `localhost:80` if it runs on the host.
3. **DNS**: check that `freepages.dev` has a DNS record `*` → `CNAME` → `<tunnel-id>.cfargotunnel.com`, **Proxied**. The dashboard creates it for normal hostnames but often not for the wildcard; if it's missing, add it by hand. The tunnel ID is shown on the tunnel's overview page.
4. **`.env`**: `PUBLIC_URL=https://pub.raixo.org`, `SITE_DOMAIN=freepages.dev`.

Any domain works the same way. Just change `SITE_DOMAIN`, the tunnel hostnames, and (on Dokploy) the Traefik rule. A two-level wildcard like `*.pub.raixo.org` would need Cloudflare's paid Advanced Certificate Manager, because the free certificate only covers one level of subdomains.

### Running cloudflared next to the app (plain Compose)

```bash
# .env: TUNNEL_TOKEN=... (from the Zero Trust dashboard)
docker compose --profile tunnel up -d --build
```

Point the tunnel's public hostnames at `http://publisher:3000`.

## Deploying on Dokploy

1. Create a **Compose** service from this repo and set **Compose Path** to `./docker-compose.dokploy.yml`.
2. In **Environment** set `ADMIN_PASSWORD`, `PUBLIC_URL=https://pub.raixo.org`, `SITE_DOMAIN=freepages.dev` (or empty).
3. Deploy. Routing is done by the Traefik labels in the compose file, not the Domains tab, because they include the wildcard rule:
   ```
   Host(`pub.raixo.org`) || Host(`freepages.dev`) || HostRegexp(`^[a-z0-9-]+\.freepages\.dev$`)
   ```
   If you use other domains, edit that line.
4. Point the Cloudflare Tunnel hostnames (`pub.raixo.org`, `freepages.dev` and `*.freepages.dev`) at Dokploy's Traefik over plain HTTP: `http://localhost:80` if cloudflared runs on the host, or `http://dokploy-traefik:80` if it runs in Docker on `dokploy-network`. Cloudflare terminates TLS, so the router uses the `web` (HTTP) entrypoint.

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
