import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setAccessToken } from "@/lib/auth-token";

/**
 * Control-plane email/password login. Stores JWT in localStorage for AuthGuard.
 */
export function LoginPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as { from?: string; reason?: string } | null;
  const from = state?.from ?? "/vendor-console";
  const sessionExpired = state?.reason === "session_expired";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const apiBase = import.meta.env.VITE_ADMIN_API_BASE_URL?.replace(/\/$/, "") ?? "";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiBase) {
      setError("VITE_ADMIN_API_BASE_URL is not configured.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? `Login failed (${res.status})`);
        return;
      }
      if (!data.access_token) {
        setError("No access_token in response.");
        return;
      }
      setAccessToken(data.access_token);
      navigate(from, { replace: true });
    } catch {
      setError("Network error — check API URL and CORS.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface-0 px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md rounded-lg border border-surface-border bg-surface-1 p-6 shadow-panel"
      >
        <h1 className="text-lg font-semibold text-text-primary">
          {t("login.title", "Vendor console")}
        </h1>
        <p className="mt-2 text-sm text-text-secondary">
          {t("login.subtitle", "Sign in with your control-plane account.")}
        </p>
        {sessionExpired ? (
          <div
            className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100"
            role="status"
          >
            <p className="font-medium">{t("session.expired.title", "Session expired")}</p>
            <p className="mt-1 text-amber-50/90">
              {t("session.expired.message", "Your session has expired. Please sign in again.")}
            </p>
          </div>
        ) : null}
        <div className="mt-6 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>
        {error ? <p className="mt-4 text-sm text-text-danger">{error}</p> : null}
        <Button type="submit" className="mt-6 w-full" disabled={submitting}>
          {submitting ? "…" : t("login.submit", "Sign in")}
        </Button>
      </form>
    </div>
  );
}
