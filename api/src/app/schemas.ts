/** Request schemas shared by several route families. */
import { z } from "zod";

import { parseMinimumVersion } from "./force-update.js";

/** Any catalog edition id (system or custom). Existence checked against DB on write. */
export const EditionIdSchema = z.string().min(2).max(64);

export const ForceUpdateModeSchema = z.enum(["off", "required", "emergency", "inherit"]);
export const CohortForceUpdateModeSchema = z.enum(["off", "required", "emergency"]);

/**
 * Forced-update floor set by an operator: MAJOR.MINOR.PATCH[-prerelease], with the loose forms
 * "2", "2.0" and "v2.0.0" accepted (same parser the activation check uses). A floor the check
 * could not read would block every PC under "required", so it is refused when set. null clears.
 */
export const ForceMinAppVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .refine((v) => parseMinimumVersion(v) !== null, {
    message: "Minimum app version must look like 1.8.0 (MAJOR.MINOR.PATCH; \"2\", \"2.0\" and \"v2.0.0\" are accepted)",
  });
