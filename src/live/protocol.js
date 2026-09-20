export const eventId = () => `live_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
export const aborted = () => new DOMException("Voice connection was cancelled", "AbortError");
export const errorFrom = (value) => value instanceof Error ? value : Object.assign(
  new Error(value?.error?.message ?? value?.message ?? "Voice connection failed"),
  { code: value?.error?.code ?? value?.code },
);

export function conciseContext(text) {
  // Bound byte-level tokenization even for non-Latin text. Canonical text stays whole.
  const encoder = new TextEncoder();
  let result = "";
  let bytes = 0;
  for (const character of text) {
    bytes += encoder.encode(character).length;
    if (bytes > 480) break;
    result += character;
  }
  return result;
}

export function waitFor(target, type, ready, { timeoutMs, signal, message }) {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      target.removeEventListener?.(type, check);
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve();
    };
    const check = () => { if (ready()) finish(); };
    const cancel = () => finish(aborted());
    const timer = setTimeout(() => finish(new Error(message)), timeoutMs);
    target.addEventListener?.(type, check);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    else check();
  });
}
