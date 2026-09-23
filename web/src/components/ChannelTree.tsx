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
import type { ConfigCategory, ConfigChannel, Selection } from "../types.js";
import { ChannelIcon } from "./ChannelIcon.js";

function SortableChannel({
  channel,
  index,
  selected,
  onSelect,
}: {
  channel: ConfigChannel;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const id = `channel-${index}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="channel-row">
      <button
        type="button"
        className={`list-item${selected ? " active" : ""}`}
        onClick={onSelect}
        data-testid={`channel-item-${channel.name}`}
      >
        <span className="drag-handle" {...attributes} {...listeners} title="Drag channel">
          ⋮⋮
        </span>
        <span className="channel-icon">
          <ChannelIcon type={channel.type} />
        </span>
        <span className="role-name">{channel.name}</span>
      </button>
    </div>
  );
}

export function ChannelTree({
  categories,
  channels,
  selection,
  onSelect,
  onReorderChannels,
  onAddCategory,
  onAddChannel,
}: {
  categories: ConfigCategory[];
  channels: ConfigChannel[];
  selection: Selection;
  onSelect: (sel: Selection) => void;
  onReorderChannels: (channels: ConfigChannel[]) => void;
  onAddCategory: () => void;
  onAddChannel: (categoryName: string | null) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  const uncategorized = channels
    .map((ch, index) => ({ ch, index }))
    .filter(({ ch }) => !ch.category);

  function channelsInCategory(catName: string) {
    return channels.map((ch, index) => ({ ch, index })).filter(({ ch }) => ch.category === catName);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = Number(String(active.id).replace("channel-", ""));
    const newIndex = Number(String(over.id).replace("channel-", ""));
    if (Number.isNaN(oldIndex) || Number.isNaN(newIndex)) return;

    const moved = channels[oldIndex];
    const target = channels[newIndex];
    if (!moved || !target) return;

    // Moving onto a channel in another category adopts that category
    const next = arrayMove(channels, oldIndex, newIndex).map((ch, i) => {
      if (i !== newIndex) return ch;
      return { ...ch, category: target.category ?? null, position: i };
    });
    // Re-assign positions within each category bucket
    const byCat = new Map<string, number>();
    const positioned = next.map((ch) => {
      const key = ch.category ?? "";
      const pos = byCat.get(key) ?? 0;
      byCat.set(key, pos + 1);
      return { ...ch, position: pos };
    });
    onReorderChannels(positioned);
  }

  const allChannelIds = channels.map((_, i) => `channel-${i}`);

  return (
    <section className="panel panel-channels" data-testid="channel-tree">
      <div className="panel-header">
        <span>Channels</span>
        <div className="panel-header-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onAddCategory}
            data-testid="add-category"
          >
            + Category
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => onAddChannel(null)}
            data-testid="add-channel"
          >
            + Channel
          </button>
        </div>
      </div>
      <div className="panel-body">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={allChannelIds} strategy={verticalListSortingStrategy}>
            {categories.map((cat, catIndex) => {
              const kids = channelsInCategory(cat.name);
              return (
                <div
                  key={`${cat.name}-${catIndex}`}
                  className="category-block"
                  data-testid={`category-${cat.name}`}
                >
                  <div className="category-row">
                    <button
                      type="button"
                      className={`list-item${selection?.kind === "category" && selection.index === catIndex ? " active" : ""}`}
                      onClick={() => onSelect({ kind: "category", index: catIndex })}
                      data-testid={`category-item-${cat.name}`}
                    >
                      <span className="category-caret" aria-hidden>
                        ▾
                      </span>
                      {cat.name}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      title="Add channel in category"
                      onClick={() => onAddChannel(cat.name)}
                      data-testid={`add-channel-in-${cat.name}`}
                    >
                      +
                    </button>
                  </div>
                  {kids.map(({ ch, index }) => (
                    <SortableChannel
                      key={`ch-${index}-${ch.name}`}
                      channel={ch}
                      index={index}
                      selected={selection?.kind === "channel" && selection.index === index}
                      onSelect={() => onSelect({ kind: "channel", index })}
                    />
                  ))}
                </div>
              );
            })}

            {uncategorized.length > 0 ? (
              <div className="category-block" data-testid="category-uncategorized">
                <div className="category-row">
                  <div className="list-item" style={{ cursor: "default" }}>
                    Uncategorized
                  </div>
                </div>
                {uncategorized.map(({ ch, index }) => (
                  <SortableChannel
                    key={`ch-${index}-${ch.name}`}
                    channel={ch}
                    index={index}
                    selected={selection?.kind === "channel" && selection.index === index}
                    onSelect={() => onSelect({ kind: "channel", index })}
                  />
                ))}
              </div>
            ) : null}
          </SortableContext>
        </DndContext>
        {categories.length === 0 && channels.length === 0 ? (
          <div className="empty-state">
            No channels yet.
            <br />
            Add a category or channel to start the layout.
          </div>
        ) : null}
      </div>
    </section>
  );
}
