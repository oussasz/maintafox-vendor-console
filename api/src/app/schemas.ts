/** Request schemas shared by several route families. */
import { z } from "zod";

/** Any catalog edition id (system or custom). Existence checked against DB on write. */
export const EditionIdSchema = z.string().min(2).max(64);

export const ForceUpdateModeSchema = z.enum(["off", "required", "emergency", "inherit"]);
export const CohortForceUpdateModeSchema = z.enum(["off", "required", "emergency"]);
