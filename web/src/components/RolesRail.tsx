import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ConfigRole, Selection } from "../types.js";
import { colorToHex } from "../utils.js";

function SortableRole({
  role,
  index,
  selected,
  onSelect,
  onMove,
  total,
}: {
  role: ConfigRole;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onMove: (from: number, to: number) => void;
  total: number;
}) {
  const id = `role-${index}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="role-row">
      {/* biome-ignore lint/a11y/useSemanticElements: the row wraps nested action
          buttons (move up/down), which a semantic <button> element cannot contain. */}
      <div
        className={`list-item${selected ? " active" : ""}`}
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onSelect();
        }}
        data-testid={`role-item-${role.name}`}
      >
        <span className="drag-handle" {...attributes} {...listeners} title="Drag role">
          ⋮⋮
        </span>
        <span className="role-swatch" style={{ background: colorToHex(role.color) }} aria-hidden />
        <span className="role-name">{role.name}</span>
        {role.hoist ? <span className="badge">hoist</span> : null}
        <span className="role-controls">
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-icon"
            disabled={index === 0}
            aria-label={`Move ${role.name} up`}
            data-testid={`role-move-up-${role.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onMove(index, index - 1);
            }}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-icon"
            disabled={index >= total - 1}
            aria-label={`Move ${role.name} down`}
            data-testid={`role-move-down-${role.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onMove(index, index + 1);
            }}
          >
            ↓
          </button>
        </span>
      </div>
    </div>
  );
}

export function RolesRail({
  roles,
  selection,
  onSelect,
  onReorder,
  onAdd,
}: {
  roles: ConfigRole[];
  selection: Selection;
  onSelect: (sel: Selection) => void;
  onReorder: (roles: ConfigRole[]) => void;
  onAdd: () => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );
  const ids = roles.map((_, i) => `role-${i}`);

  function applyOrder(next: ConfigRole[]) {
    onReorder(
      next.map((r, i) => ({
        ...r,
        position: next.length - i,
      })),
    );
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    applyOrder(arrayMove(roles, oldIndex, newIndex));
  }

  function handleMove(from: number, to: number) {
    if (to < 0 || to >= roles.length) return;
    applyOrder(arrayMove(roles, from, to));
  }

  return (
    <aside className="panel" data-testid="roles-rail">
      <div className="panel-header">
        <span>Roles</span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onAdd}
          data-testid="add-role"
        >
          + Add
        </button>
      </div>
      <div className="panel-body">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {roles.map((role, index) => (
              <SortableRole
                key={`${role.name}-${index}`}
                role={role}
                index={index}
                total={roles.length}
                selected={selection?.kind === "role" && selection.index === index}
                onSelect={() => onSelect({ kind: "role", index })}
                onMove={handleMove}
              />
            ))}
          </SortableContext>
        </DndContext>
        {roles.length === 0 ? (
          <div className="empty-state">
            No roles yet.
            <br />
            Add roles before wiring channel overwrites.
          </div>
        ) : null}
      </div>
    </aside>
  );
}
