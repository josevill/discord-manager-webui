import type { PlanActionType, PlanView, PlanViewAction } from "../utils.js";

const SECTION_ORDER: { type: PlanActionType; label: string }[] = [
  { type: "CREATE", label: "Create" },
  { type: "UPDATE", label: "Update" },
  { type: "DELETE", label: "Delete" },
  { type: "SKIP", label: "Skip" },
];

function typeClass(type: PlanActionType): string {
  switch (type) {
    case "CREATE":
      return "create";
    case "UPDATE":
      return "update";
    case "DELETE":
      return "delete";
    case "SKIP":
      return "skip";
  }
}

function groupActions(actions: PlanViewAction[]): Map<PlanActionType, PlanViewAction[]> {
  const map = new Map<PlanActionType, PlanViewAction[]>();
  for (const section of SECTION_ORDER) map.set(section.type, []);
  for (const action of actions) {
    map.get(action.type)?.push(action);
  }
  return map;
}

export function PlanViewList({ view }: { view: PlanView }) {
  if (view.kind === "execute") {
    return (
      <div className="plan-view" data-testid="plan-view">
        <div className="plan-view-summary" data-testid="plan-view-summary">
          <span className={`plan-view-count${view.applied > 0 ? " create" : ""}`}>
            {view.applied} applied
          </span>
          <span className={`plan-view-count${view.skipped > 0 ? " skip" : ""}`}>
            {view.skipped} skipped
          </span>
          <span className={`plan-view-count${view.failed.length > 0 ? " delete" : ""}`}>
            {view.failed.length} failed
          </span>
        </div>
        {view.failed.length > 0 ? (
          <section className="plan-view-section" data-testid="plan-view-section-failed">
            <header className="plan-view-section-header">Failed · {view.failed.length}</header>
            <ul className="plan-view-rows">
              {view.failed.map((f, idx) => (
                <li
                  key={`${f.resource}-${idx}`}
                  className="plan-view-row delete"
                  data-testid="plan-view-row"
                >
                  <div className="plan-view-row-primary">
                    {f.type ? <span className="plan-view-domain">{f.type}</span> : null}
                    <span className="plan-view-resource">{f.resource || "unknown"}</span>
                  </div>
                  {f.error ? (
                    <div className="plan-view-row-reason" title={f.error}>
                      {f.error}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    );
  }

  const grouped = groupActions(view.actions);
  const { summary } = view;

  return (
    <div className="plan-view" data-testid="plan-view">
      <div className="plan-view-summary" data-testid="plan-view-summary">
        <span className={`plan-view-count${summary.creates > 0 ? " create" : ""}`}>
          {summary.creates} create
        </span>
        <span className={`plan-view-count${summary.updates > 0 ? " update" : ""}`}>
          {summary.updates} update
        </span>
        <span className={`plan-view-count${summary.deletes > 0 ? " delete" : ""}`}>
          {summary.deletes} delete
        </span>
        <span className={`plan-view-count${summary.skips > 0 ? " skip" : ""}`}>
          {summary.skips} skip
        </span>
        {view.dryRun ? <span className="plan-view-dry-run">dry-run</span> : null}
      </div>

      {SECTION_ORDER.map(({ type, label }) => {
        const rows = grouped.get(type) ?? [];
        if (rows.length === 0) return null;
        return (
          <section
            key={type}
            className="plan-view-section"
            data-testid={`plan-view-section-${type.toLowerCase()}`}
          >
            <header className="plan-view-section-header">
              {label} · {rows.length}
            </header>
            <ul className="plan-view-rows">
              {rows.map((action, idx) => (
                <li
                  key={`${action.type}-${action.domain}-${action.resource}-${idx}`}
                  className={`plan-view-row ${typeClass(action.type)}`}
                  data-testid="plan-view-row"
                >
                  <div className="plan-view-row-primary">
                    {action.domain ? (
                      <span className="plan-view-domain">{action.domain}</span>
                    ) : null}
                    <span className="plan-view-resource">{action.resource || "unknown"}</span>
                  </div>
                  {action.reason ? (
                    <div className="plan-view-row-reason" title={action.reason}>
                      {action.reason}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
