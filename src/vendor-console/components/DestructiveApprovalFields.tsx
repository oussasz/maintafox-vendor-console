import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const REASON_CODES = ["REV-CS", "SEC-INC", "BILL-DISPUTE", "OPS-MISTAKE", "OTHER"] as const;

export interface DestructiveApprovalFieldsProps {
  reasonCode: string;
  onReasonCode: (v: string) => void;
  secondActorId: string;
  onSecondActorId: (v: string) => void;
  rationale: string;
  onRationale: (v: string) => void;
  disabled?: boolean;
}

/** Dual-confirmation + mandatory reason for revocation, expiry, or slot reduction (server enforces). */
export function DestructiveApprovalFields({
  reasonCode,
  onReasonCode,
  secondActorId,
  onSecondActorId,
  rationale,
  onRationale,
  disabled,
}: DestructiveApprovalFieldsProps) {
  const { t } = useTranslation("vendorConsole");

  return (
    <div className="space-y-4 rounded-md border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
      <p className="text-sm font-medium text-amber-950 dark:text-amber-100">
        {t("destructive.title")}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="reason-code">{t("destructive.reasonCode")}</Label>
          <Select value={reasonCode} onValueChange={onReasonCode} disabled={disabled ?? false}>
            <SelectTrigger id="reason-code">
              <SelectValue placeholder={t("destructive.pickReason")} />
            </SelectTrigger>
            <SelectContent>
              {REASON_CODES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="second-actor">{t("destructive.secondActor")}</Label>
          <Input
            id="second-actor"
            value={secondActorId}
            onChange={(e) => onSecondActorId(e.target.value)}
            placeholder="user-id"
            disabled={disabled}
            autoComplete="off"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="rationale">{t("destructive.rationale")}</Label>
        <Textarea
          id="rationale"
          value={rationale}
          onChange={(e) => onRationale(e.target.value)}
          rows={3}
          disabled={disabled}
          placeholder={t("destructive.rationalePh")}
        />
      </div>
    </div>
  );
}
