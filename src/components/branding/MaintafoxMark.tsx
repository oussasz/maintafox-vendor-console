import logoColor from "@/assets/logo/maintafox-logo-color.svg";
import logoWhite from "@/assets/logo/maintafox-logo-white.svg";
import { cn } from "@/lib/utils";

/**
 * The official Maintafox mark (flame and gear), copied unchanged from the desktop app
 * (maintafox-desktop/src/assets/logo). "color" on light backgrounds, "white" on the navy sidebar
 * and other dark backgrounds. Decorative: the word "Maintafox" is always written next to it.
 */
export function MaintafoxMark({ variant, size = 32, className }: { variant: "color" | "white"; size?: number; className?: string }) {
  return (
    <img
      src={variant === "white" ? logoWhite : logoColor}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
      data-testid={`maintafox-mark-${variant}`}
      className={cn("shrink-0 select-none", className)}
    />
  );
}
