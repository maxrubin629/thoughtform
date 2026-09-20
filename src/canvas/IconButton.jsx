export function IconButton({
  label,
  children,
  type = "button",
  active = false,
  pressed,
  disabled = false,
  onClick,
  className = "",
  testId,
}) {
  return (
    <button
      type={type}
      className={`icon-button ${active ? "is-active" : ""} ${className}`}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      {children}
    </button>
  );
}
