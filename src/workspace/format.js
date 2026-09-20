function formatDate(value, options, fallback) {
  const date = value ? new Date(value) : null;
  return !date || Number.isNaN(date.valueOf())
    ? fallback
    : new Intl.DateTimeFormat(undefined, options).format(date);
}

export const formatClock = (value) => formatDate(value, { hour: "numeric", minute: "2-digit" }, "");
export const formatUpdated = (value) => formatDate(value, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }, "Recently");
export const nodeLabel = (node) => node?.text ?? node?.lines?.join(" ") ?? "Thought";
