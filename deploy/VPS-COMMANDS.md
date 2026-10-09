# Deploy console + API on your VPS (Docker Compose)

**Production URLs (HTTPS):**

- Console: `https://console.maintafox.systems`
- API: `https://api.maintafox.systems`

**Sync exchange (Postgres mirror + MinIO):** see [`SYNC_EXCHANGE.md`](./SYNC_EXCHANGE.md).

**DNS:** Both hostnames must resolve to your server’s public IP (same A record target).

---

## 1. On your PC — upload the project

Use **PowerShell** (from `C:\Dev\MaintafoxSuite\desktop`):

```powershell
cd C:\Dev\MaintafoxSuite\desktop
tar -czvf "$env:TEMP\mvc.tgz" --exclude=node_modules --exclude=dist --exclude=.git maintafox-vendor-console
scp "$env:TEMP\mvc.tgz" root@YOUR_SERVER_IP:/opt/mvc.tgz
```

Or use WinSCP / FileZilla to upload the `maintafox-vendor-console` folder to `/opt/maintafox-vendor-console`.

---

## 2. On the server — unpack

```bash
cd /opt
tar -xzf mvc.tgz
cd /opt/maintafox-vendor-console
```

---

## 3. Create environment file

```bash
cp .env.example .env
nano .env
```

Set at least:

- `JWT_SECRET` — long random string (e.g. `openssl rand -hex 32`)
- `SEED_ADMIN_PASSWORD` — strong password for the first admin (used only on first DB seed)
- `SEED_ADMIN_EMAIL` — optional (default `admin@maintafox.systems`)

`VITE_ADMIN_API_BASE_URL` must stay **`https://api.maintafox.systems`** so the built SPA calls the correct API.

---

## 4. Install Docker (Ubuntu 24.04)

```bash
apt-get update
apt-get install -y docker.io docker-compose-plugin
systemctl enable --now docker
```

---

## 5. Open firewall ports (SSH + HTTPS)

```bash
ufw allow 'Nginx Full'
ufw allow 22/tcp
ufw --force enable
```

(If you use another firewall, allow TCP 22, 80, and 443.)

---

## 6. Build and start the stack

```bash
cd /opt/maintafox-vendor-console
docker compose --env-file .env up -d --build
```

Check:

```bash
docker compose ps
curl -s -H "Host: api.maintafox.systems" http://127.0.0.1/health
```

From your laptop (after DNS propagates):

```bash
curl -s https://api.maintafox.systems/health
curl -sI https://console.maintafox.systems
```

---

## 7. Log in to the vendor console

1. Open `https://console.maintafox.systems` in a browser.
2. Sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `.env`.

The API seeds the admin user **only when the database is empty** (first run). To change the password later, add users or SQL updates — or remove the volume and re-seed (destructive).

---

## 8. HTTPS and TLS certificates

Production terminates TLS in the **edge** nginx container (`deploy/nginx-edge.conf`). Issue certificates on the host with Certbot, then mount `/etc/letsencrypt` into the edge service (see `docker-compose.yml`).

```bash
apt-get install -y certbot
certbot certonly --webroot -w /opt/maintafox-vendor-console/deploy/certbot-webroot \
  -d console.maintafox.systems -d api.maintafox.systems
docker compose --env-file .env up -d --force-recreate edge
```

Certbot auto-renewal: `systemctl is-active certbot.timer` should be `active`.

---

## 9. Monthly security maintenance

Run on the VPS (or after uploading the latest repo):

```bash
cd /opt/maintafox-vendor-console
bash deploy/vps-security-maintenance.sh          # updates + verify
bash deploy/vps-security-maintenance.sh --reboot # include kernel reboot when needed
```

The script:

- runs `apt full-upgrade` and `autoremove`
- enables unattended security upgrades (`/etc/apt/apt.conf.d/20auto-upgrades`)
- restarts Docker, pulls the edge nginx image, and recreates the edge container
- neutralizes cloud-init SSH password-auth override
- verifies `https://api.maintafox.systems/health` and HTTP→HTTPS redirect

**Post-maintenance checklist:**

| Check | Command |
|-------|---------|
| Kernel current | `uname -r` |
| No pending security updates | `apt list --upgradable 2>/dev/null \| grep security` |
| Auto-updates enabled | `cat /etc/apt/apt.conf.d/20auto-upgrades` |
| Services up | `systemctl is-active docker fail2ban ufw` |
| API healthy | `curl -sf https://api.maintafox.systems/health` |
| Cert valid | `certbot certificates` |

---

## Troubleshooting

| Issue | What to check |
|--------|----------------|
| `502` / `nginx` errors | `docker compose logs edge`, `docker compose logs api` |
| CORS errors in browser | `CORS_ORIGIN` in `.env` must include `https://console.maintafox.systems` |
| Login always fails | API logs; DB seeded? `docker compose logs api` |
| Wrong host | DNS A records for **both** subdomains → same VPS IP |
| Immediate “Access denied” without login | Stale/invalid `localStorage` token was treated as auth. Redeploy SPA with auth-before-authz fix; clear site data or open incognito. Confirm `VITE_ADMIN_API_BASE_URL=https://api.maintafox.systems` at **image build** time. |

---

## Auth smoke checks (after `docker compose up -d --build`)

Confirm env in `.env` before rebuild:

- `CORS_ORIGIN=https://console.maintafox.systems`
- `VITE_ADMIN_API_BASE_URL=https://api.maintafox.systems` (baked into SPA at build)

```bash
# Login → expect access_token
curl -sS -X POST https://api.maintafox.systems/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"YOUR_ADMIN_EMAIL","password":"YOUR_PASSWORD"}'

# Valid token → 200
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://api.maintafox.systems/api/v1/me/permissions \
  -H "Authorization: Bearer TOKEN"

# Invalid token → 401 (must not be 200)
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://api.maintafox.systems/api/v1/me/permissions \
  -H 'Authorization: Bearer invalid'
```

Browser scenarios:

1. Anonymous (incognito / clear `maintafox:vendor:access_token`) → `/login`
2. Valid admin login → `/vendor-console` loads
3. Authenticated without required permission → Access Denied (API currently returns full permission set for all users; empty-set path covered in unit tests)
4. Expired JWT → redirect `/login` with session-expired message
5. Garbage token in localStorage → redirect `/login` (JWT shape check + API 401)

---

## API endpoints (current)

- `GET /health`
- `POST /api/v1/auth/login` — body `{ "email", "password" }` → `{ access_token, token_type, expires_in }`
- `GET /api/v1/me/permissions` — header `Authorization: Bearer <token>`
- `GET /api/v1/tenants` — auth required
- `POST /api/v1/tenants` — auth required, body `{ slug, display_name, force_min_app_version? }`
- `POST /api/v1/licenses` — auth required, body `{ tenant_id, max_machines, expires_at? }`
- `GET /api/v1/tenants/:tenantId/licenses` — auth required
- `POST /api/v1/licenses/:licenseId/revoke` — auth required
- `POST /api/v1/activation/claim` — no auth, body `{ license_key, machine_fingerprint, machine_label?, app_version? }`

SQLite data: Docker volume `control_api_data` (persisted).
