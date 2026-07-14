import type { ReactNode } from "react";

interface ButtonProps {
  label: string;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "destructive";
  size?: "sm" | "md";
  disabled?: boolean;
  icon?: ReactNode;
  type?: "button" | "submit";
  className?: string;
}

export function Button({ label, onClick, variant = "secondary", size = "md", disabled, icon, type = "button", className }: ButtonProps) {
  const cls = [
    "btn",
    variant === "primary" && "btn--primary",
    variant === "ghost" && "btn--ghost",
    variant === "destructive" && "btn--destructive",
    size === "sm" && "btn--sm",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled}>
      {icon}
      {label}
    </button>
  );
}

interface IconButtonProps {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  size?: "sm" | "md";
  disabled?: boolean;
}

/** Sadece ikon gösteren buton — label erişilebilirlik için title/aria-label olur. */
export function IconButton({ icon, label, onClick, size = "md", disabled }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-btn${size === "sm" ? " icon-btn--sm" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {icon}
    </button>
  );
}
