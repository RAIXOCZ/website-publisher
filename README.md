# website-publisher

Drop a folder, get a website. A small self-hosted static site publisher with a Czech and English UI. The language follows the browser (Czech/Slovak → Czech, anything else → English), and visitors can switch with the CS/EN toggle; their choice is remembered.

- **Upload page** (`/`): drag & drop a folder (or a `.zip`), arrange it in a file tree (add files/folders, new folders, move, rename, replace, remove), look at a **5-minute preview** at `preview-xxxxxx`, then publish.
- **Accounts by e-mail, no passwords**: a visitor enters e-mail, first and last name; the site goes live once they click the confirmation link, which also creates the account. Later sign-ins use one-time e-mail links. Signed-in users publish immediately.
- **Editing**: an existing site opens in the same file tree; replace single files, a folder or everything, add and remove, preview, save (atomic swap).
- **Account page** (`/ucet`): sites, name, API tokens for curl/CI, activity history (with IPs, without e-mails), account deletion confirmed by e-mail.
- **CLI**: `curl -H "Authorization: Bearer fp_…" -F name=my-site -F overwrite=1 -F f=@site.zip https://freepages.dev/api/sites`.
- **Admin panel** (`/admin`, not linked anywhere, behind `ADMIN_PASSWORD`): all sites with owners, users, activity history with IPs and e-mails, rename/edit/delete/purge sites and accounts, IP whitelist.
- **Retention**: deleted sites and accounts stop being public immediately and are purged automatically after 90 days (`RETENTION_DAYS`); the admin can purge at once. Activity history is capped at 12 months (`AUDIT_DAYS`).
- **IP whitelist**: from whitelisted IPs (`IP_WHITELIST` or the admin panel) publishing works without an account, with per-site passwords remembered in the browser (the original mode).
- **Guide** (`/docs`), **terms** (`/podminky`) and **privacy policy** (`/soukromi`).
- Each site gets its own subdomain, e.g. `https://<name>.freepages.dev/`, or without `SITE_DOMAIN` a path, `PUBLIC_URL/<name>/`.
- Everything is stored in one Docker volume (`/data`), including a SQLite database (Node's built-in `node:sqlite`, no native dependencies).

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
/data/sites/<name>/     published files
/data/freepages.db      accounts, sites, activity history (SQLite, WAL)
/data/trash/            deleted sites, kept until purged
/data/pending/          uploads waiting for e-mail confirmation (24 h)
/data/previews/         5-minute previews
/data/.session-secret
```

Back up that volume and you have backed up everything. The privacy policy promises that backups are kept for at most 30 days, so rotate them accordingly.

Sites that existed before accounts were introduced are moved to the `ADMIN_EMAIL` account on the first start (their old passwords are dropped).

### Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_PASSWORD` | required | Password for `/admin`. Changing it logs the admin out. |
| `RESEND_API_KEY` | empty | API key of [Resend](https://resend.com) (free tier: 3,000 e-mails a month). Without it no e-mails are sent, so nobody outside the IP whitelist can publish or sign in. |
| `MAIL_FROM` | `Freepages <noreply@SITE_DOMAIN>` | Sender; must be on a domain verified in Resend. |
| `ADMIN_EMAIL` | `martin@balcar.me` | Account that receives the sites published before accounts existed. |
| `IP_WHITELIST` | empty | Comma-separated IPs that may publish without an account (password sites). More can be added in `/admin`. |
| `RETENTION_DAYS` | `90` | How long deleted sites and accounts are kept before they are purged. |
| `AUDIT_DAYS` | `365` | Activity history entries are deleted after this. |
| `PREVIEW_MINUTES` | `5` | Lifetime of previews. |
| `PUBLIC_URL` | `http://localhost:3000` | Address of the publisher as the browser sees it, e.g. `https://freepages.dev`. Secure cookies are enabled when it starts with `https`. |
| `SITE_DOMAIN` | empty | Empty: sites live at `PUBLIC_URL/<name>/`. Set to `freepages.dev`: sites live at `https://<name>.freepages.dev/` and the path URLs redirect there. |
| `PUBLISH_PER_HOUR` | `60` | Anonymous uploads allowed per IP address per hour (signed-in users and the admin are not limited). |
| `EMAILS_PER_HOUR` | `10` | E-mails per IP address and per recipient per hour. |
| `MAX_UPLOAD_MB` | `100` | Upload limit. Cloudflare Free/Pro rejects request bodies over 100 MB anyway. |
| `PATH_SANDBOX` | `true` | Serve path-style sites with a CSP sandbox (see Security). |

### Setting up e-mail (Resend)

1. Create a free account at https://resend.com and add your domain (e.g. `freepages.dev`) under *Domains*. Prefer the EU region (`eu-west-1`).
2. Add the DNS records Resend shows (SPF/DKIM TXT and MX on a `send.` subdomain) in Cloudflare DNS. They must be **DNS only** (grey cloud).
3. Wait until the domain shows *Verified*, then create an API key with *Sending access* and put it into `RESEND_API_KEY`.
4. In the domain settings, keep **click and open tracking off**, otherwise the one-time links are rewritten through Resend.
5. Accept Resend's data processing agreement (DPA) in the account settings; the privacy policy relies on it.

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
- Publishing needs a confirmed e-mail address, and every account, upload, edit, sign-in and e-mail is logged with its IP address (visible in `/admin`). Uploads and e-mails are capped per IP per hour.
- E-mail links, sessions and API tokens are random 192-bit values stored only as SHA-256 hashes. E-mail links are used up by a button click on `/email/<token>`, not by opening the link, so mail scanners can't consume them.
- Site passwords (whitelist mode) are generated by the server (about 60 random bits) and stored only as salted hashes. Wrong site or admin passwords count towards the same per-IP lockout.
- State-changing API calls require a custom header plus a matching `Origin` (requests with an `Authorization: Bearer` token are exempt: they carry no cookies). The admin cookie is `HttpOnly; SameSite=Strict`, the user cookie `HttpOnly; SameSite=Lax`.
- Wrong passwords are rate-limited to `MAX_FAILED_ATTEMPTS` (default 10) per IP per 15 minutes.
- Every response, including published sites, carries a `Report-Abuse: martin@balcar.me` header, and every page links to abuse reports in the footer.
- Upload paths are sanitized (`..` is rejected), zip extraction counts uncompressed bytes against the limit, and a publish swaps directories atomically.

## Development

```bash
npm install
npm run dev     # ADMIN_PASSWORD=dev, data in ./data, http://localhost:3000
                # e-mails are printed to the console instead of being sent
```

## Tests

End-to-end tests use Playwright and click through the upload page, file tree editor, previews, e-mail confirmation and sign-in, the account page (tokens, curl, history, deletion), the admin panel (sites, users, history, purge, whitelist), whitelist password sites, the guide and the language switch. They also cover site serving, the `Report-Abuse` header and subdomain routing.

```bash
npm install
npx playwright install chromium   # once
npm test
```

`npm test` starts three throwaway servers (path mode on :4317, subdomain mode on :4318, IP-whitelisted on :4319) with temporary data directories and `MAIL_DEV_OUTBOX=1`, so e-mails are read from `/api/dev/outbox` instead of being sent. It never touches real data.
