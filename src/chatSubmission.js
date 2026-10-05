// A retry belongs to the failed submission, never to a matching transcript label.
// Successful repeated messages, changed drafts and different maps get fresh IDs.
export function createChatSubmission({ createId = () => `chat_${crypto.randomUUID()}` } = {}) {
  const pending = new Map();
  return {
    edit(sessionId, text) {
      if (pending.get(sessionId)?.text !== text.trim()) pending.delete(sessionId);
    },
    async send(sessionId, text, submit) {
      let draft = pending.get(sessionId);
      if (!draft || draft.text !== text) {
        draft = { text, requestId: createId(), task: null };
        pending.set(sessionId, draft);
      }
      if (draft.task) return draft.task;
      draft.task = Promise.resolve().then(() => submit(text, { requestId: draft.requestId }));
      try {
        const result = await draft.task;
        if (pending.get(sessionId) === draft) pending.delete(sessionId);
        return result;
      } finally { draft.task = null; }
    },
  };
}
