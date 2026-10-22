import { cn } from "@/lib/utils";
import { fontWeights } from "@/lib/font-weight";
import type { FileGroup, GroupCount } from "@/lib/file-groups";

interface TypeFilterProps {
  groups: GroupCount[];
  total: number;
  /** null is "All". */
  selected: FileGroup | null;
  onSelect: (group: FileGroup | null) => void;
}

export function TypeFilter({ groups, total, selected, onSelect }: TypeFilterProps) {
  return (
    <div
      role="group"
      aria-label="Filter by type"
      // p-0.5 leaves room for the pills' ring, which overflow would clip.
      className="mt-1.5 flex gap-1.5 overflow-x-auto p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <Pill label="All" count={total} active={selected === null} onClick={() => onSelect(null)} />
      {groups.map((g) => (
        <Pill
          key={g.id}
          label={g.label}
          count={g.count}
          active={selected === g.id}
          onClick={() => onSelect(selected === g.id ? null : g.id)}
        />
      ))}
    </div>
  );
}

function Pill({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      // Keep focus in the search box.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-lg px-2.5 py-1 text-[11px] leading-3.5 transition-colors duration-80",
        active ? "bg-white text-black" : "bg-black text-zinc-300 hover:bg-zinc-900"
      )}
      style={{
        fontVariationSettings: fontWeights.semibold,
        boxShadow: "0 0 0 1px rgb(255 255 255 / 0.1), 0 2px 6px rgb(0 0 0 / 0.4)",
      }}
    >
      {label} <span className={active ? "text-black/50" : "text-zinc-500"}>{count}</span>
    </button>
  );
}
