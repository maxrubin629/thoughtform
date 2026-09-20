import { IconLink, IconX } from "@tabler/icons-react";
import { IconButton } from "../canvas/IconButton.jsx";

/** Composer state and saving belong to the workspace; this form owns no map state. */
export function ThoughtEditor({ composer, value, saving, parentLabel = "selected thought", onChange, onSubmit, onClose }) {
  if (!composer) return null;
  const title = composer.fresh ? "New thought"
    : composer.mode === "edit" ? "Edit thought"
      : composer.parentId ? "New connected thought" : "New thought";
  return <form className="session-composer" onSubmit={onSubmit} aria-label={title}>
    <header className="thought-editor-header">
      <div><strong>{title}</strong>
        {composer.parentId && <small><IconLink />Connected to {parentLabel}</small>}
      </div>
      <IconButton label="Close thought editor" disabled={saving} onClick={onClose}><IconX /></IconButton>
    </header>
    <textarea aria-label="Thought text" autoFocus rows="3" value={value} disabled={saving}
      onChange={(event) => onChange(event.target.value)} placeholder="What's the thought?" onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.form.requestSubmit();
        }
      }} />
    <footer className="thought-editor-footer">
      <small>Enter to save · Shift + Enter for a new line</small>
      <button type="submit" disabled={!value.trim() || saving}>{saving ? "Saving…" : composer.mode === "edit" ? "Save" : "Add thought"}</button>
    </footer>
  </form>;
}
