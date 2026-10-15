const emptyWorkspace = () => ({ version: 1, active_session_id: null, sessions: {} });

/** One IndexedDB transaction owns each read/modify/write, including across tabs.
 * The complete canonical records live here; display projections are never saved.
 */
export function createExampleStore({ indexedDB = globalThis.indexedDB, name = "thoughtform-example-v1" } = {}) {
  let opening;
  const open = () => {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!indexedDB) { reject(new Error("Browser storage is unavailable. Enable site storage to use the example.")); return; }
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("workspace");
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Close other ThoughtForm example tabs, then reopen this one."));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = undefined; };
        resolve(db);
      };
    }).catch(error => { opening = undefined; throw error; });
    return opening;
  };

  async function transaction(mode, transform) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("workspace", mode);
      const records = tx.objectStore("workspace");
      let result;
      let failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("The example could not be saved. Your previous saved map is unchanged."));
      tx.onerror = () => { failure ??= tx.error; };
      const request = records.get("current");
      request.onsuccess = () => {
        try {
          const state = request.result ?? emptyWorkspace();
          if (state.version !== 1 || !state.sessions || typeof state.sessions !== "object") throw new Error("This saved example has an unsupported format.");
          // Transformations must be synchronous to stay inside the transaction.
          result = transform(state);
          if (result?.then) throw new Error("Example transactions must be synchronous.");
          if (mode === "readwrite") records.put(state, "current");
        } catch (error) { failure = error; tx.abort(); }
      };
    });
  }

  return {
    read: transform => transaction("readonly", transform),
    write: transform => transaction("readwrite", transform),
    async close() { if (opening) (await opening).close(); opening = undefined; },
  };
}
