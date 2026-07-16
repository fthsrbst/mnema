import { useId, type ReactNode } from "react";

interface FieldWrapProps {
  label: string;
  hideLabel?: boolean;
  optional?: boolean;
  children: (id: string) => ReactNode;
}

function FieldWrap({ label, hideLabel, optional, children }: FieldWrapProps) {
  const id = useId();
  return (
    <div className="field">
      {!hideLabel && (
        <label htmlFor={id} className="field-label">
          {label}
          {optional && <span className="field-optional"> ({"opsiyonel"})</span>}
        </label>
      )}
      {children(id)}
    </div>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hideLabel?: boolean;
  optional?: boolean;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  type?: "text" | "password" | "email";
  hasClear?: boolean;
  className?: string;
}

export function TextField({ label, value, onChange, hideLabel, optional, disabled, placeholder, type = "text", hasClear, className }: TextFieldProps) {
  return (
    <FieldWrap label={label} hideLabel={hideLabel} optional={optional}>
      {(id) => (
        <div className="input-wrap">
          <input
            id={id}
            className={`input${className ? ` ${className}` : ""}`}
            value={value}
            type={type}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            aria-label={hideLabel ? label : undefined}
          />
          {hasClear && value && (
            <button type="button" className="input-clear" onClick={() => onChange("")} aria-label="Temizle">
              ×
            </button>
          )}
        </div>
      )}
    </FieldWrap>
  );
}

interface TextAreaProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hideLabel?: boolean;
  optional?: boolean;
  rows?: number;
  placeholder?: string;
  spellCheck?: boolean;
}

export function TextArea({ label, value, onChange, hideLabel, optional, rows = 4, placeholder, spellCheck = true }: TextAreaProps) {
  return (
    <FieldWrap label={label} hideLabel={hideLabel} optional={optional}>
      {(id) => (
        <textarea
          id={id}
          className="textarea"
          value={value}
          rows={rows}
          placeholder={placeholder}
          spellCheck={spellCheck}
          onChange={(e) => onChange(e.target.value)}
          aria-label={hideLabel ? label : undefined}
        />
      )}
    </FieldWrap>
  );
}

interface SelectProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  hideLabel?: boolean;
  placeholder?: string;
}

export function Select({ label, value, onChange, options, hideLabel, placeholder }: SelectProps) {
  return (
    <FieldWrap label={label} hideLabel={hideLabel}>
      {(id) => (
        <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)} aria-label={hideLabel ? label : undefined}>
          {placeholder && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </FieldWrap>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="switch">
      <span className="switch-track" data-on={checked} onClick={() => onChange(!checked)}>
        <span className="switch-thumb" />
      </span>
      <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>{label}</span>
    </label>
  );
}
