interface TabsProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: string }[];
}

export function Tabs<T extends string>({ value, onChange, items }: TabsProps<T>) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          className="tab"
          data-active={value === it.value}
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function SegmentedControl<T extends string>({ value, onChange, items }: TabsProps<T>) {
  return (
    <div className="segmented" role="tablist">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          className="segmented-item"
          data-active={value === it.value}
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
