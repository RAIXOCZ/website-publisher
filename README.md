# website-publisher

Drop a folder, get a website. A small self-hosted static site publisher with a Czech and English UI. The language follows the browser (Czech/Slovak → Czech, anything else → English), and visitors can switch with the CS/EN toggle; their choice is remembered.

- **Upload page** (`/`): anyone can drag & drop a folder (or a `.zip`), no account needed. The site is live as soon as the upload finishes.
- **Per-site passwords**: every new site gets a generated password. Replacing or deleting a site needs it. The browser remembers it in `localStorage`, and the upload page lists those sites under *Moje weby*. A site can be added on another device with its name and password.
- **Admin panel** (`/admin`, not linked anywhere): behind `ADMIN_PASSWORD`, lists every site and can replace, rename, delete it or generate a new password for it.
- **Guide** (`/docs`): how to publish, for whoever uses it.
- Each site gets its own subdomain, e.g. `https://<name>.freepages.dev/`, or without `SITE_DOMAIN` a path, `PUBLIC_URL/<name>/`.
- Everything is stored in one Docker volume (`/data`). There is no database.

## Quick start

There are two compose files:

- `docker-compose.yml` is for **Dokploy**. It publishes no ports; Dokploy's Traefik reaches the container over `dokploy-network`. See [Deploying on Dokploy](#deploying-on-dokploy).
- `docker-compose.local.yml` is for plain Docker. It publishes port `HOST_PORT` (default 3000):

```bash
cp .env.example .env        # set ADMIN_PASSWORD (and PUBLIC_URL / SITE_DOMAIN)
docker compose -f docker-compose.local.yml up -d --build
```

Open http://localhost:3000 and drop a folder. The admin panel is at http://localhost:3000/admin.

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
| `ADMIN_PASSWORD` | required | Password for `/admin`. Publishing needs no login. Changing it logs the admin out. |
| `PUBLIC_URL` | `http://localhost:3000` | Address of the publisher as the browser sees it, e.g. `https://freepages.dev`. Secure cookies are enabled when it starts with `https`. |
| `SITE_DOMAIN` | empty | Empty: sites live at `PUBLIC_URL/<name>/`. Set to `freepages.dev`: sites live at `https://<name>.freepages.dev/` and the path URLs redirect there. |
| `PUBLISH_PER_HOUR` | `60` | Uploads allowed per IP address per hour (the admin is not limited). |
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

### Running cloudflared next to the app (without Dokploy)

```bash
# .env: TUNNEL_TOKEN=... (from the Zero Trust dashboard)
docker compose -f docker-compose.local.yml --profile tunnel up -d --build
```

Point the tunnel's public hostnames at `http://publisher:3000`.

## Deploying on Dokploy

1. Create a **Compose** service from this repo. Keep the default **Compose Path** (`./docker-compose.yml`). No host port is published, so it can't clash with other apps.
2. In **Environment** set `ADMIN_PASSWORD`, `PUBLIC_URL=https://freepages.dev`, `SITE_DOMAIN=freepages.dev`.
3. Deploy. Routing is done by the Traefik labels in the compose file, not the Domains tab, because they include the wildcard rule:
   ```
   Host(`freepages.dev`) || HostRegexp(`^[a-z0-9-]+\.freepages\.dev$`)
   ```
   If you use other domains, edit that line.
4. Point the Cloudflare Tunnel hostnames (`freepages.dev` and `*.freepages.dev`) at Dokploy's Traefik over plain HTTP: `http://localhost:80` if cloudflared runs on the host, or `http://dokploy-traefik:80` if it runs in Docker on `dokploy-network`. Cloudflare terminates TLS, so the router uses the `web` (HTTP) entrypoint.

## Security notes

- Uploaded sites can contain arbitrary JavaScript. With subdomains each site has its own origin, so it is isolated from the admin panel. In path mode, sites share the admin's origin, so they are served with a CSP `sandbox` (opaque origin). Their scripts can't use your session, but they also can't use `localStorage` or cookies. Prefer subdomain mode if your sites need those.
- Site passwords are generated by the server (about 60 random bits) and stored only as salted SHA-256 hashes in `/data/meta/<name>.json`. Wrong site or admin passwords count towards the same per-IP lockout.
- Publishing is open, so anyone can use your domain to host pages. Uploads are capped per IP per hour; watch `/admin` for abuse and delete anything unwanted.
- State-changing API calls require a custom header plus a matching `Origin`, and the session cookie is `HttpOnly; SameSite=Strict`.
- Login is rate-limited to 10 failures per IP per 15 minutes.
- Upload paths are sanitized (`..` is rejected), zip extraction counts uncompressed bytes against the limit, and a publish swaps directories atomically.

## Development

```bash
npm install
npm run dev     # ADMIN_PASSWORD=dev, data in ./data, http://localhost:3000
```
