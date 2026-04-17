# Deploy vendor console (Docker) on your VPS

This folder documents how to run **`maintafox-vendor-console`** on a Linux VPS (e.g. Debian/Ubuntu) with Docker. Automated SSH login with a **password** is not used in scripts; use **SSH keys** or type the password once in an interactive session.

## 0. Security

- Do not commit `.env` with secrets.
- Prefer `ssh-copy-id` so you never paste root passwords into scripts.
- Rotate the server password if it was shared in chat.

## 1. On your laptop (one-time)

From `maintafox-vendor-console/`:

```bash
# Optional: verify build (requires Docker)
docker compose build
```

### Copy the project to the server

**Linux / macOS** (if `rsync` is installed):

```bash
cd /path/to/maintafox-vendor-console
rsync -avz --exclude node_modules --exclude dist ./ root@YOUR_SERVER_IP:/opt/maintafox-vendor-console/
```

**Windows PowerShell** — `rsync` is usually missing; use **`tar` + `scp`** (included with Windows 10+). Your repo path:

`C:\Dev\MaintafoxSuite\desktop\maintafox-vendor-console`

```powershell
cd C:\Dev\MaintafoxSuite\desktop
tar -czvf "$env:TEMP\mvc.tgz" --exclude=node_modules --exclude=dist --exclude=.git maintafox-vendor-console
scp "$env:TEMP\mvc.tgz" root@YOUR_SERVER_IP:/opt/mvc.tgz
```

Replace `YOUR_SERVER_IP` with your VPS address (e.g. `188.165.123.199`). Enter your SSH password when prompted.

**On the server** (after `ssh root@YOUR_SERVER_IP`):

```bash
cd /opt
tar -xzf mvc.tgz
ls -la maintafox-vendor-console
```

You should have `/opt/maintafox-vendor-console` with the project files.
</think>


<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>
Read

## 2. On the server — full stack (console + API + edge)

Follow **`deploy/VPS-COMMANDS.md`** for copy-paste steps: Docker, `.env`, `docker compose up`, DNS, and smoke tests.

The Compose file runs **edge** nginx on port **80** with virtual hosts `console.maintafox.systems` and `api.maintafox.systems`.

## 3. TLS + HTTPS (optional)

Point DNS **A** records for both subdomains → server IP. For HTTPS, put **Certbot + Nginx on the host** in front of port 80, or terminate TLS in another proxy. See `deploy/host-nginx-console.maintafox.systems.conf` for a host-only reverse-proxy pattern (adjust upstream to `127.0.0.1:80` when using the edge container).

## 4. What the included API covers

The **`api/`** service provides JWT login and `GET /api/v1/me/permissions` for the vendor console. **Tenants, license keys, and audit APIs** are still to be added as your product grows.
