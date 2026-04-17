# Maintafox vendor console (web)

Standalone React (Vite) app for **business and license management** on your VPS. The desktop app remains **maintenance operations only**; it no longer embeds this UI.

## Develop

```bash
pnpm install
# Optional: work without a real API
# echo VITE_DEV_MOCK_AUTH=true > .env.local
pnpm dev
```

Open http://localhost:5174 — with mock auth, use the **Continue** link on the login screen.

## Build

```bash
pnpm build
```

Output: `dist/`. Deploy those files behind HTTPS.

## Docker Compose (console + API on the VPS)

The repo includes a **control API** (`api/`: email/password → JWT, `GET /api/v1/me/permissions`) and an **edge** nginx that routes:

- `http://console.maintafox.systems` → vendor console SPA  
- `http://api.maintafox.systems` → API  

**Full server command list:** [`deploy/VPS-COMMANDS.md`](deploy/VPS-COMMANDS.md)

Quick local check (requires Docker):

```bash
cp .env.example .env
# Edit .env — set JWT_SECRET, SEED_ADMIN_PASSWORD
docker compose --env-file .env up -d --build
```

Add to your hosts file for testing: `127.0.0.1 console.maintafox.systems api.maintafox.systems`

TLS: use Certbot on the host or a reverse proxy in front of port 80; see `deploy/DEPLOY.md` and `deploy/host-nginx-console.maintafox.systems.conf` for host-nginx patterns.

## Environment

| Variable | Description |
|----------|-------------|
| `VITE_ADMIN_API_BASE_URL` | Base URL of your admin API (e.g. `https://api.maintafox.systems`). The UI calls `GET /api/v1/me/permissions` with `Authorization: Bearer <token>`. Adjust `src/services/admin-permissions.ts` if your routes differ. |
| `VITE_DEV_MOCK_AUTH` | Set to `true` for local UI-only work (full vendor permission set, no token). |
| `VITE_BASE_PATH` | Vite `base` option if not served at domain root (default `/`). |

## Deployment: console.maintafox.systems

1. Point DNS **A** record `console.maintafox.systems` → your VPS (e.g. `188.165.123.199`).
2. Copy `dist/*` to the server, e.g. `/var/www/maintafox-vendor-console`.
3. Use the sample Nginx config in `deploy/nginx-console.maintafox.systems.conf` (enable TLS with Let’s Encrypt or your CA).
4. Ensure your API sends CORS headers for `https://console.maintafox.systems` if the API is on another origin.

**Security:** Do not commit real passwords or tokens. Rotate any credentials that were exposed in chat or logs.

## Desktop app

Product license onboarding and offline-first sync live in the `maintafox-desktop` repo. The vendor UI was removed from the Tauri build; use this project for operator workflows.

### Forced client updates

The desktop app uses the Tauri updater channel (see desktop `updater` / settings). A future control-plane endpoint can mark a tenant or machine as **must update**; the client applies that when sync runs online. Wire the vendor “rollouts” UI to that API when the backend is ready.
