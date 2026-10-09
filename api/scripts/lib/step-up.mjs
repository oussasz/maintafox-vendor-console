/**
 * Shared helper for integration scripts: obtain a real step-up token by re-verifying the
 * operator password (POST /api/v1/auth/step-up). Privileged routes reject anything else.
 */
export async function obtainStepUpToken(baseUrl, accessToken, password) {
  const res = await fetch(`${baseUrl}/api/v1/auth/step-up`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.status !== 200) {
    throw new Error(`step-up failed with HTTP ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  if (typeof body.step_up_token !== "string" || body.step_up_token.length === 0) {
    throw new Error("step-up response missing step_up_token");
  }
  return body.step_up_token;
}
