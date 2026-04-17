# Deploy console + API on your VPS (Docker Compose)

**URLs (HTTP as requested):**

- Console: `http://console.maintafox.systems`
- API: `http://api.maintafox.systems`

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

`VITE_ADMIN_API_BASE_URL` must stay **`http://api.maintafox.systems`** so the built SPA calls the correct API.

---

## 4. Install Docker (Ubuntu 24.04)

```bash
apt-get update
apt-get install -y docker.io docker-compose-plugin
systemctl enable --now docker
```

---

## 5. Open port 80 (HTTP)

```bash
ufw allow 80/tcp
ufw allow 22/tcp
ufw --force enable
```

(If you use another firewall, allow TCP 80.)

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
curl -s http://api.maintafox.systems/health
curl -sI http://console.maintafox.systems
```

---

## 7. Log in to the vendor console

1. Open `http://console.maintafox.systems` in a browser.
2. Sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `.env`.

The API seeds the admin user **only when the database is empty** (first run). To change the password later, add users or SQL updates — or remove the volume and re-seed (destructive).

---

## 8. HTTPS (recommended after HTTP works)

Use **Certbot** with **Nginx on the host** in front of Docker, or move TLS to a reverse proxy. Until then, HTTP is fine for testing only.

---

## Troubleshooting

| Issue | What to check |
|--------|----------------|
| `502` / `nginx` errors | `docker compose logs edge`, `docker compose logs api` |
| CORS errors in browser | `CORS_ORIGIN` in `.env` must be `http://console.maintafox.systems` |
| Login always fails | API logs; DB seeded? `docker compose logs api` |
| Wrong host | DNS A records for **both** subdomains → same VPS IP |

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
