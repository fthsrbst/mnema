export function Divider() {
  return <hr className="divider" />;
}

export function SectionRule({ label }: { label: string }) {
  return (
    <div className="section-rule">
      <span className="u-label">{label}</span>
      <Divider />
    </div>
  );
}
