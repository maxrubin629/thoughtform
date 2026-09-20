import { useEffect, useRef, useState } from "react";
import { IconCheck, IconChevronDown, IconLasso, IconMarquee } from "@tabler/icons-react";

const MODES = [
  { mode: "rectangle", label: "Rectangle select", icon: IconMarquee, testId: "marquee-tool" },
  { mode: "lasso", label: "Lasso select", icon: IconLasso, testId: "lasso-tool" },
];

/** Owns the picker; onChange receives the next mode, including null when toggled off. */
export function SelectionTools({ selectionMode, onChange }) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef(null);
  const focusTrigger = () => pickerRef.current?.querySelector('[data-testid="selection-tools"]')?.focus();
  useEffect(() => {
    if (!open) return;
    const picker = pickerRef.current;
    picker?.querySelector("[data-selection-option]")?.focus();
    const dismissOutside = (event) => {
      if (!picker?.contains(event.target)) setOpen(false);
    };
    const dismissOnEscape = (event) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      focusTrigger();
      // The workspace also handles Escape to exit the mode and clear selection.
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [open]);
  const SelectionIcon = selectionMode === "lasso" ? IconLasso : IconMarquee;
  return <div className="selection-picker" ref={pickerRef} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button type="button" className={`icon-button selection-picker-trigger ${selectionMode !== null || open ? "is-active" : ""}`}
      aria-label="Selection tools" title="Selection tools" aria-expanded={open} aria-controls="selection-modes"
      onClick={() => setOpen((value) => !value)} data-testid="selection-tools">
      <SelectionIcon /><IconChevronDown className="selection-picker-chevron" />
    </button>
    {open && <div id="selection-modes" className="selection-picker-menu" role="group" aria-label="Selection mode">
      {MODES.map(({ mode, label, icon: ModeIcon, testId }) => (
        <button type="button" key={mode} aria-pressed={selectionMode === mode} data-selection-option data-testid={testId}
          onClick={() => {
            onChange(selectionMode === mode ? null : mode);
            setOpen(false);
            focusTrigger();
          }}>
          <ModeIcon /><span>{label}</span>{selectionMode === mode && <IconCheck className="selection-picker-check" />}
        </button>
      ))}
      <small>Esc to exit selection</small>
    </div>}
  </div>;
}
