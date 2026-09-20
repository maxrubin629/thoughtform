import { RevisionConflictError, SessionOperationError } from "./sessionOperations.mjs";

export function errorPayload(error, snapshot) {
  const { snapshot: _nestedSnapshot, ...details } = error?.details ?? {};
  return {
    ok: false,
    error: {
      code: error?.code ?? "request_failed",
      message: error?.message ?? "The request failed",
      retryable: Boolean(error?.retryable),
      ...details,
    },
    ...(snapshot ? { revision: snapshot.revision, snapshot } : {}),
  };
}

export function createJsonRoute({ store, snapshotFor }) {
  return (handler) => async (req, res) => {
    try {
      const value = await handler(req, res);
      if (!res.headersSent) res.json(value);
    } catch (error) {
      const status = error?.status ?? (error instanceof RevisionConflictError ? 409 : 500);
      let snapshot = error?.snapshot ?? error?.details?.snapshot ?? null;
      if (!snapshot && req.params?.id) {
        snapshot = await store.get(req.params.id).catch(() => null);
      }
      if (snapshot) snapshot = snapshotFor(snapshot);
      if (status >= 500 && !(error instanceof SessionOperationError)) console.error(error);
      const payload = errorPayload(error, snapshot);
      res.status(status).json(payload);
    }
  };

}
