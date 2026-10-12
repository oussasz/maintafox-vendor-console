/**
 * Console operators and roles (control API routes/operators.ts, master plan Phase 4.3). Every
 * change needs a reason and a `vendor_user_admin` step-up; the server enforces roles on every route.
 */
import { z } from "zod";

import { authFetch } from "@/lib/api-client";
import {
  parseControlPlaneErrorResponse,
  privilegedHeaders,
  type PrivilegedActionContext,
} from "@/services/license-control-service";

export const OPERATOR_ROLES = ["owner", "operations", "support", "auditor"] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

const OperatorSchema = z.object({
  id: z.number().int(),
  email: z.string(),
  display_name: z.string().nullable(),
  role: z.enum(OPERATOR_ROLES),
  is_active: z.boolean(),
  mfa_enrolled: z.boolean(),
  created_at: z.string(),
  last_login_at: z.string().nullable(),
  open_sessions: z.number().int().min(0),
});
export type Operator = z.infer<typeof OperatorSchema>;

async function json<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  if (!res.ok) throw new Error(await parseControlPlaneErrorResponse(res));
  return schema.parse(await res.json());
}

export async function listOperators(): Promise<Operator[]> {
  return json(await authFetch("/api/v1/operators"), z.array(OperatorSchema));
}

/** Creates an operator; returns the one-time enrolment code their first sign-in needs. */
export async function createOperator(
  input: { email: string; display_name: string; role: OperatorRole; initial_password: string },
  privileged: PrivilegedActionContext,
): Promise<{ operator: Operator; enrolment_code: string }> {
  const res = await authFetch("/api/v1/operators", {
    method: "POST",
    body: JSON.stringify(input),
    headers: privilegedHeaders(privileged),
  });
  return json(res, z.object({ operator: OperatorSchema, enrolment_code: z.string() }));
}

export async function updateOperator(
  id: number,
  patch: { display_name?: string; role?: OperatorRole; is_active?: boolean },
  privileged: PrivilegedActionContext,
): Promise<Operator> {
  const res = await authFetch(`/api/v1/operators/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    headers: privilegedHeaders(privileged),
  });
  return (await json(res, z.object({ operator: OperatorSchema }))).operator;
}

export async function deleteOperator(id: number, privileged: PrivilegedActionContext): Promise<void> {
  const res = await authFetch(`/api/v1/operators/${id}`, { method: "DELETE", headers: privilegedHeaders(privileged) });
  await json(res, z.object({ ok: z.literal(true) }));
}

/** Resets another operator's second factor; returns the one-time reset code to give them. */
export async function resetOperatorMfa(id: number, privileged: PrivilegedActionContext): Promise<string> {
  const res = await authFetch(`/api/v1/operators/${id}/mfa-reset`, { method: "POST", headers: privilegedHeaders(privileged) });
  return (await json(res, z.object({ reset_code: z.string() }))).reset_code;
}

/** Changes the signed-in operator's password; their other sessions end. */
export async function changeOwnPassword(currentPassword: string, newPassword: string): Promise<number> {
  const res = await authFetch("/api/v1/auth/password", {
    method: "POST",
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  return (await json(res, z.object({ other_sessions_ended: z.number().int() }))).other_sessions_ended;
}
