// Display copy only. Never apply this to transcript, source text, or stored records.
export function suggestionDisplayText(value) {
  if (typeof value !== "string") return value;
  return value.replace(/(?<![\w-])proposals?(?![\w-])/gi, (word) => {
    const replacement = word.toLowerCase() === "proposals" ? "suggestions" : "suggestion";
    if (word === word.toUpperCase()) return replacement.toUpperCase();
    return word[0] === word[0].toUpperCase()
      ? replacement[0].toUpperCase() + replacement.slice(1)
      : replacement;
  });
}
