import { useCallback, useState } from "react";
import type { AlertPhase } from "../components/AlertModal.js";
import type { ValidationIssue } from "../types.js";
import type { PlanView } from "../utils.js";

export type AlertAction = "fetch" | "plan" | "dry-run" | "apply";

export type AlertState =
  | { open: false }
  | {
      open: true;
      action: AlertAction;
      phase: AlertPhase;
      title: string;
      message: string;
      issues?: ValidationIssue[];
      detail?: string;
      planView?: PlanView | null;
      confirmLabel?: string;
      confirmDanger?: boolean;
    };

export type AlertFlow = Pick<ReturnType<typeof useAlertFlow>, "setAlert" | "showAlertError">;

/**
 * Owns the single global AlertModal state (confirm → pending → success/error).
 * Kept out of App.tsx so the plan/apply run logic can be composed as a hook.
 */
export function useAlertFlow() {
  const [alert, setAlert] = useState<AlertState>({ open: false });

  const closeAlert = useCallback(() => setAlert({ open: false }), []);

  const showAlertError = useCallback(
    (
      action: AlertAction,
      title: string,
      message: string,
      opts?: { issues?: ValidationIssue[]; detail?: string },
    ) => {
      setAlert({
        open: true,
        action,
        phase: "error",
        title,
        message,
        issues: opts?.issues,
        detail: opts?.detail,
      });
    },
    [],
  );

  return { alert, setAlert, closeAlert, showAlertError };
}
