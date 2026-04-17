import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { Label } from "./label";

interface FormFieldProps {
  /** Unique field identifier (used for htmlFor and aria-describedby) */
  name: string;
  /** Field label text */
  label: string;
  /** Optional description shown below the label */
  description?: string | undefined;
  /** Error message string (from react-hook-form errors) */
  error?: string | undefined;
  /** Whether the field is required */
  required?: boolean;
  /** The form control (input, textarea, select, etc.) */
  children: ReactNode;
  /** Additional className for the wrapper */
  className?: string;
}

/**
 * Reusable form field wrapper. Provides consistent label, description,
 * and error display for all form controls.
 */
export function FormField({
  name,
  label,
  description,
  error,
  required,
  children,
  className,
}: FormFieldProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={name} className={cn(error && "text-status-danger")}>
        {label}
        {required && <span className="text-status-danger ml-0.5">*</span>}
      </Label>
      {description && (
        <p id={`${name}-description`} className="text-xs text-text-muted">
          {description}
        </p>
      )}
      {children}
      {error && (
        <p id={`${name}-error`} role="alert" className="text-xs text-status-danger">
          {error}
        </p>
      )}
    </div>
  );
}
