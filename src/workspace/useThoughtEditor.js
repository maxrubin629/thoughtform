import { useRef, useState } from "react";
import { BASE_HEIGHT, BASE_WIDTH } from "../canvas/viewport.js";
import { clamp } from "../fluidMaterial.js";
import { nodeLabel } from "./format.js";

const boundedPosition = ({ x, y }) => ({
  x: clamp(x, 60, BASE_WIDTH - 60),
  y: clamp(y, 140, BASE_HEIGHT - 60),
});

/** Owns drafts and the single write that creates or edits a thought. */
export function useThoughtEditor({ perform, runCommand, selectOne }) {
  const [composer, setComposer] = useState(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const close = () => setComposer(null);
  const reset = () => { close(); setValue(""); };
  const openNew = ({ parentId = null, position } = {}) => {
    if (submitting.current) return;
    setComposer({ mode: "add", parentId, ...(position ? { position: boundedPosition(position) } : {}) });
    setValue("");
  };
  const openEdit = (node) => {
    if (!node || submitting.current) return;
    setComposer({ mode: "edit", id: node.id });
    setValue(nodeLabel(node));
  };
  const spawnFreeform = (x, y) => runCommand(async () => {
    const result = await perform({ type: "create_bubble", text: "New thought", create_distinct: true, parent_reference: null, ...boundedPosition({ x, y }) });
    const id = result?.affected_ids?.[0];
    if (!id) return;
    selectOne(id);
    setComposer({ mode: "edit", id, fresh: true });
    setValue("");
  });
  const submit = async (event) => {
    event.preventDefault();
    const text = value.trim();
    if (!text || !composer || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    try {
      await runCommand(async () => {
        const editing = composer.mode === "edit";
        const result = await perform(editing
          ? { type: "edit_bubble", node_reference: composer.id, text }
          : { type: "create_bubble", text, create_distinct: true, parent_reference: composer.parentId ?? null, ...(composer.position ?? {}) });
        const id = editing ? composer.id : result?.affected_ids?.[0];
        if (id) selectOne(id);
        reset();
      });
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };
  return { composer, value, saving, setValue, close, reset, openNew, openEdit, spawnFreeform, submit };
}
