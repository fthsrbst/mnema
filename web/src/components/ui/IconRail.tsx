import { Icon, type IconName } from "../icons/Icons";

export interface RailItem {
  id: string;
  label: string;
  icon: IconName;
}

export function IconRail({
  items,
  active,
  expanded,
  onSelect,
}: {
  items: RailItem[];
  active: string;
  expanded: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="icon-rail" aria-label="Ana bölümler">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className="icon-rail-btn"
          data-active={active === it.id}
          onClick={() => onSelect(it.id)}
          title={expanded ? undefined : it.label}
          aria-label={it.label}
          aria-current={active === it.id ? "page" : undefined}
        >
          <Icon name={it.icon} size={18} />
          <span className="icon-rail-label">{it.label}</span>
        </button>
      ))}
    </nav>
  );
}
