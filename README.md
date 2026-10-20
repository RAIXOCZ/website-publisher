# website-publisher

Drop a folder, get a website. A small self-hosted static site publisher with a Czech UI:

- **Upload page** (`/`): drag & drop a folder (or a `.zip`) and it is live as soon as the upload finishes.
- **Admin panel** (`/admin`): list, rename and delete sites. Protected by `ADMIN_PASSWORD` from `.env`.
- **Guide** (`/docs`): how to publish, for whoever uses it.
- Sites are served either as `https://pub.raixo.org/<name>/` or, with `SITE_DOMAIN`, on their own subdomain `https://<name>.pub.raixo.org/`.
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
| `SITE_DOMAIN` | empty | Empty: sites live at `PUBLIC_URL/<name>/`. Set to `pub.raixo.org`: sites live at `https://<name>.pub.raixo.org/` and the path URLs redirect there. |
| `PUBLIC_UPLOAD` | `false` | `true` lets anyone publish without a password (they can't replace existing sites). |
| `MAX_UPLOAD_MB` | `100` | Upload limit. Cloudflare Free/Pro rejects request bodies over 100 MB anyway. |
| `PATH_SANDBOX` | `true` | Serve path-style sites with a CSP sandbox (see Security). |

## Deploying with Cloudflare Tunnel

### Option A: one domain, sites as paths (`pub.raixo.org/<name>/`)

Works with zero extra setup:

1. In Zero Trust → Networks → Tunnels → your tunnel → **Public hostnames**, add `pub.raixo.org` → `http://<host>:3000` (or the Dokploy Traefik, see below).
2. `.env`: `PUBLIC_URL=https://pub.raixo.org`, `SITE_DOMAIN=` (empty).

### Option B: a subdomain per site (`<name>.pub.raixo.org`)

The app already supports this: it reads the `Host` header, so one container serves every subdomain. You need to route `*.pub.raixo.org` to it:

1. **DNS**: in Cloudflare DNS add a proxied `CNAME` record `*.pub` → `<tunnel-id>.cfargotunnel.com`. The dashboard usually doesn't create wildcard records for you.
2. **Tunnel**: add a public hostname with subdomain `*.pub`, domain `raixo.org`, pointing to the same service as `pub.raixo.org`. More specific hostnames always win over the wildcard.
3. **`.env`**: `PUBLIC_URL=https://pub.raixo.org`, `SITE_DOMAIN=pub.raixo.org`.
4. **TLS certificate (the catch)**: Cloudflare's free Universal SSL only covers `raixo.org` and `*.raixo.org`, **one level deep**. `xsite.pub.raixo.org` is two levels deep, so browsers would show a certificate error. Your choices:
   - **Advanced Certificate Manager** (about $10/month per zone): order a certificate for `*.pub.raixo.org` (SSL/TLS → Edge Certificates → Order advanced certificate). Nothing else changes.
   - **Use one level instead** (free): `SITE_DOMAIN=raixo.org`, so sites become `xsite.raixo.org`, plus a `*` wildcard DNS record and tunnel hostname. Your existing explicit subdomains keep working because specific records win. Downside: uploaded sites then share a domain with your other apps, so cookies set for `.raixo.org` would be visible to them.
   - **A separate cheap domain** (free certificate, best isolation): e.g. `raixo.site` with `SITE_DOMAIN=raixo.site` → `xsite.raixo.site`. This is the same approach as GitHub Pages using `github.io`.

### Running cloudflared next to the app (plain Compose)

```bash
# .env: TUNNEL_TOKEN=... (from the Zero Trust dashboard)
docker compose --profile tunnel up -d --build
```

Point the tunnel's public hostnames at `http://publisher:3000`.

## Deploying on Dokploy

1. Create a **Compose** service from this repo and set **Compose Path** to `./docker-compose.dokploy.yml`.
2. In **Environment** set `ADMIN_PASSWORD`, `PUBLIC_URL=https://pub.raixo.org`, `SITE_DOMAIN=pub.raixo.org` (or empty).
3. Deploy. Routing is done by the Traefik labels in the compose file, not the Domains tab, because they include the wildcard rule:
   ```
   Host(`pub.raixo.org`) || HostRegexp(`^[a-z0-9-]+\.pub\.raixo\.org$`)
   ```
   If you use other domains, edit that line.
4. Point the Cloudflare Tunnel hostnames (`pub.raixo.org` and `*.pub.raixo.org`) at Dokploy's Traefik over plain HTTP: `http://localhost:80` if cloudflared runs on the host, or `http://dokploy-traefik:80` if it runs in Docker on `dokploy-network`. Cloudflare terminates TLS, so the router uses the `web` (HTTP) entrypoint.

How hard is the wildcard on Dokploy? With the steps above it takes about 15 minutes. The only real decision is the certificate (step 4 of Option B).

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
