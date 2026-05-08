// Minimal Promise-wrapped IndexedDB key/value store. We avoid pulling in idb-keyval to
// keep the dependency surface small; this single helper is what the storage modules use.

const DB_NAME = "agnt";
const DB_VERSION = 1;
const STORE_NAME = "kv";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = run(tx.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const idb = {
  async get<T>(key: string): Promise<T | undefined> {
    return withStore<T | undefined>("readonly", (store) => store.get(key) as IDBRequest<T | undefined>);
  },
  async set<T>(key: string, value: T): Promise<void> {
    await withStore<IDBValidKey>("readwrite", (store) => store.put(value, key) as IDBRequest<IDBValidKey>);
  },
  async remove(key: string): Promise<void> {
    await withStore<undefined>("readwrite", (store) => store.delete(key) as IDBRequest<undefined>);
  },
  /** All string keys in the kv store. Used by the Settings backup/restore flow
   *  to enumerate everything without hardcoding the key list. */
  async keys(): Promise<string[]> {
    const raw = await withStore<IDBValidKey[]>("readonly", (store) => store.getAllKeys() as IDBRequest<IDBValidKey[]>);
    return raw.filter((value): value is string => typeof value === "string");
  },
};
