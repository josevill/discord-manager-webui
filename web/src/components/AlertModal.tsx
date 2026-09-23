import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ValidationIssue } from "../types.js";
import type { PlanView } from "../utils.js";
import { PlanViewList } from "./PlanViewList.js";

export type AlertPhase = "confirm" | "pending" | "success" | "error";

export interface AlertProgress {
  current: number;
  total: number;
  status: "success" | "failure" | "skip";
  label: string;
}

export interface AlertModalProps {
  open: boolean;
  phase: AlertPhase;
  title: string;
  message: string;
  issues?: ValidationIssue[];
  detail?: string;
  planView?: PlanView | null;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Use danger styling for the confirm button (e.g. Apply). */
  confirmDanger?: boolean;
  /** Extra controls rendered above the confirm/cancel buttons (e.g. the apply prune checkbox). */
  confirmExtra?: ReactNode;
  /** Progress bar for long-running pending actions (apply/dry-run streaming). */
  progress?: AlertProgress | null;
  /** Show a Cancel button while pending (aborts the in-flight run). */
  cancelPending?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
  onClose?: () => void;
}

export function AlertModal({
  open,
  phase,
  title,
  message,
  issues,
  detail,
  planView,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmDanger = false,
  confirmExtra,
  progress = null,
  cancelPending = false,
  onConfirm,
  onCancel,
  onClose,
}: AlertModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setCopied(false);
      return;
    }
    dialogRef.current?.focus();
  }, [open, phase]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (phase === "pending") return;
      e.preventDefault();
      if (phase === "confirm") {
        onCancel?.();
        return;
      }
      onClose?.();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, phase, onCancel, onClose]);

  if (!open || typeof document === "undefined") return null;

  const errorIssues = (issues ?? []).filter((i) => i.level === "error");
  const phaseClass =
    phase === "success"
      ? " success"
      : phase === "error"
        ? " error"
        : phase === "pending"
          ? " pending"
          : phase === "confirm"
            ? " confirm"
            : "";
  const showDetail = Boolean(detail || planView) && (phase === "success" || phase === "error");
  const hasPlanView = Boolean(planView);

  async function handleCopy() {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(detail);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — parent can surface copy failures elsewhere if needed
    }
  }

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a convenience; Escape and the modal's own buttons are the accessible dismissal paths
    <div
      className="alert-modal-overlay"
      data-testid="alert-modal"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (phase === "pending") return;
        if (phase === "confirm") {
          onCancel?.();
          return;
        }
        onClose?.();
      }}
    >
      <div
        ref={dialogRef}
        className={`alert-modal${phaseClass}${hasPlanView ? " with-plan" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="alert-modal-title"
        aria-describedby="alert-modal-message"
        tabIndex={-1}
      >
        <h2 id="alert-modal-title" className="alert-modal-title" data-testid="alert-modal-title">
          {title}
        </h2>

        {phase === "pending" ? (
          <div className="alert-modal-pending">
            <div className="alert-modal-spinner" aria-hidden />
            <div className="alert-modal-pending-copy">
              <p
                id="alert-modal-message"
                className="alert-modal-message"
                data-testid="alert-modal-message"
              >
                {message}
              </p>
              {progress && progress.total > 0 ? (
                <div className="alert-modal-progress" data-testid="apply-progress">
                  <div className="alert-modal-progress-bar" aria-hidden>
                    <div
                      className={`alert-modal-progress-fill${progress.status === "failure" ? " failure" : ""}`}
                      style={{
                        width: `${Math.min(100, (progress.current / progress.total) * 100)}%`,
                      }}
                    />
                  </div>
                  <div className="alert-modal-progress-text" data-testid="apply-progress-text">
                    Step {progress.current} of {progress.total} — {progress.label}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <p
            id="alert-modal-message"
            className="alert-modal-message"
            data-testid="alert-modal-message"
          >
            {message}
          </p>
        )}

        {phase === "error" && errorIssues.length > 0 ? (
          <div className="alert-modal-issues">
            {errorIssues.map((i, idx) => (
              <div key={`${i.path}-${idx}`} className="issue" data-testid="validation-issue">
                {i.path}: {i.message}
              </div>
            ))}
          </div>
        ) : null}

        {showDetail ? (
          <div
            className={`alert-modal-detail${hasPlanView ? " has-plan" : ""}`}
            data-testid="alert-modal-detail"
          >
            {detail ? (
              <button
                type="button"
                className="btn btn-sm btn-outline alert-modal-copy"
                onClick={() => void handleCopy()}
                data-testid="alert-modal-copy"
              >
                {copied ? "Copied" : "Copy JSON"}
              </button>
            ) : null}
            {planView ? (
              <div className="alert-modal-plan-scroll">
                <PlanViewList view={planView} />
              </div>
            ) : (
              <pre>{detail}</pre>
            )}
          </div>
        ) : null}

        <div className="alert-modal-actions">
          {phase === "confirm" ? (
            <>
              {confirmExtra ? (
                <div className="alert-modal-confirm-extra">{confirmExtra}</div>
              ) : null}
              <button
                type="button"
                className="btn btn-outline"
                onClick={onCancel}
                data-testid="alert-modal-cancel"
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                className={`btn ${confirmDanger ? "btn-danger" : "btn-primary"}`}
                onClick={onConfirm}
                data-testid="alert-modal-confirm"
              >
                {confirmLabel}
              </button>
            </>
          ) : null}
          {phase === "pending" && cancelPending ? (
            <button
              type="button"
              className="btn btn-outline"
              onClick={onCancel}
              data-testid="alert-modal-cancel-pending"
            >
              Cancel
            </button>
          ) : null}
          {phase === "success" || phase === "error" ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onClose}
              data-testid="alert-modal-close"
            >
              Close
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
