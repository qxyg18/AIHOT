// A value read from the database and kept in this process. Readers get it straight away within
// `freshMs`; after that the old value is still returned while a single background read replaces it,
// so no reader waits for a refresh. Past `maxStaleMs` (or before the first read) callers wait for the
// read. Concurrent readers always share one read.

export interface Cached<T> {
  get(): Promise<T>;
  clear(): void;
}

export function cached<T>(load: () => Promise<T>, opts: { freshMs: number; maxStaleMs: number }): Cached<T> {
  let value: { at: number; data: T } | null = null;
  let pending: Promise<T> | null = null;
  let generation = 0;

  const refresh = (): Promise<T> => {
    if (pending) return pending;
    const mine = generation;
    pending = load()
      .then((data) => {
        if (mine === generation) value = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  return {
    get() {
      const age = value ? Date.now() - value.at : Infinity;
      if (value && age < opts.freshMs) return Promise.resolve(value.data);
      if (value && age < opts.maxStaleMs) {
        // A failed background read keeps the old value; the next reader tries again.
        refresh().catch(() => {});
        return Promise.resolve(value.data);
      }
      return refresh();
    },
    clear() {
      generation += 1;
      value = null;
      pending = null;
    },
  };
}

/** A keyed LRU of cached reads (upstream mcp consumes; built on cached()). */
export function cachedByKey<K, T>(name: (key: K) => string, load: (key: K) => Promise<T>, opts: { freshMs: number; maxStaleMs: number; maxKeys: number }): (key: K) => Promise<T> {
  const entries = new Map<string, { get: (key: K) => Promise<T> }>();
  return (key) => {
    const id = name(key);
    let entry = entries.get(id);
    if (!entry) {
      if (entries.size >= opts.maxKeys) entries.delete(entries.keys().next().value!);
      const c = cached(() => load(key), opts);
      entries.set(id, (entry = { get: () => c.get() }));
    }
    return entry.get(key);
  };
}

/** A public search that overlapping callers share; a call that names its own clock bypasses the share. */
export function sharedSearch<K, T>(name: (key: K) => string, load: (key: K, now: Date) => Promise<T>, isSearch: (key: K) => boolean): (key: K, now?: Date) => Promise<T> {
  const pending = new Map<string, Promise<T>>();
  const search = (key: K): Promise<T> => {
    const id = name(key);
    let read = pending.get(id);
    if (!read) {
      read = load(key, new Date()).finally(() => pending.delete(id));
      pending.set(id, read);
    }
    return read;
  };
  return (key, now) => (now !== undefined && isSearch(key) ? load(key, now) : search(key));
}
