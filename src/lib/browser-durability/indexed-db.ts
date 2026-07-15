import type { DraftKey } from "@/lib/drafts/types";

import {
  draftOutboxStorageKey,
  examAnswerOutboxStorageKey,
  examEventOutboxStorageKey,
  isBrowserOutboxNamespace,
  isBrowserOutboxRecord,
  isClientEventId,
  isDraftKey,
  isDraftOutboxRecord,
  isExamAnswerOutboxRecord,
  isExamEventOutboxRecord,
  isExamItemId,
  isExamSessionId,
  isMutationId,
} from "./types";
import type {
  DraftOutboxRecord,
  ExamAnswerOutboxRecord,
  ExamEventOutboxRecord,
} from "./types";

const DATABASE_NAME = "codestead-browser-outbox-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "entries";
const NAMESPACE_INDEX = "namespace";
const NAMESPACE_KIND_SCOPE_INDEX = "namespaceKindScope";

export interface BrowserOutboxRepository {
  getDraft(namespace: string, key: DraftKey): Promise<DraftOutboxRecord | null>;
  putDraft(record: DraftOutboxRecord): Promise<void>;
  deleteDraftIfMutation(namespace: string, key: DraftKey, requestId: string): Promise<boolean>;
  listExamAnswers(namespace: string, sessionId: string): Promise<ExamAnswerOutboxRecord[]>;
  putExamAnswer(record: ExamAnswerOutboxRecord): Promise<void>;
  deleteExamAnswerIfMutation(
    namespace: string,
    sessionId: string,
    itemId: string,
    clientMutationId: string,
  ): Promise<boolean>;
  listExamEvents(namespace: string, sessionId: string): Promise<ExamEventOutboxRecord[]>;
  putExamEvent(record: ExamEventOutboxRecord): Promise<void>;
  deleteExamEvent(namespace: string, sessionId: string, clientEventId: string): Promise<void>;
  clearExamSession(namespace: string, sessionId: string): Promise<void>;
  clearNamespace(namespace: string): Promise<void>;
  clearForeignNamespaces(currentNamespace: string): Promise<void>;
  clearAll(): Promise<void>;
  close(): void;
}

type TransactionContext<T> = {
  store: IDBObjectStore;
  setResult(value: T): void;
  abort(error: unknown): void;
};

function indexedDbError(message: string) {
  return new Error(message);
}

function transactionAbortError() {
  return new DOMException("IndexedDB transaction aborted.", "AbortError");
}

function runTransaction<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  initialResult: T,
  execute: (context: TransactionContext<T>) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE_NAME, mode);
    } catch (error) {
      reject(error);
      return;
    }

    let result = initialResult;
    let operationError: unknown;
    let settled = false;
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const abort = (error: unknown) => {
      operationError = error;
      try {
        transaction.abort();
      } catch {
        rejectOnce(error);
      }
    };

    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    transaction.onerror = () => {
      rejectOnce(operationError
        ?? transaction.error
        ?? indexedDbError("IndexedDB transaction failed."));
    };
    transaction.onabort = () => {
      rejectOnce(operationError ?? transaction.error ?? transactionAbortError());
    };

    try {
      execute({
        store: transaction.objectStore(STORE_NAME),
        setResult(value) {
          result = value;
        },
        abort,
      });
    } catch (error) {
      abort(error);
    }
  });
}

function handleSuccess<T>(
  request: IDBRequest<T>,
  abort: (error: unknown) => void,
  callback: (result: T) => void,
) {
  request.onsuccess = () => {
    try {
      callback(request.result);
    } catch (error) {
      abort(error);
    }
  };
}

function deleteCursorMatches(
  request: IDBRequest<IDBCursorWithValue | null>,
  abort: (error: unknown) => void,
) {
  handleSuccess(request, abort, (cursor) => {
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  });
}

function compareRecords(
  left: { updatedAt: string; storageKey: string },
  right: { updatedAt: string; storageKey: string },
) {
  if (left.updatedAt < right.updatedAt) return -1;
  if (left.updatedAt > right.updatedAt) return 1;
  if (left.storageKey < right.storageKey) return -1;
  if (left.storageKey > right.storageKey) return 1;
  return 0;
}

function requireNamespace(namespace: string) {
  if (!isBrowserOutboxNamespace(namespace)) throw new Error("Browser outbox namespace is invalid.");
}

function requireDraftKey(key: DraftKey) {
  if (!isDraftKey(key)) throw new Error("Draft outbox key is invalid.");
}

function requireSessionId(sessionId: string) {
  if (!isExamSessionId(sessionId)) throw new Error("Exam session ID is invalid.");
}

class IndexedDbBrowserOutbox implements BrowserOutboxRepository {
  constructor(private readonly database: IDBDatabase) {}

  async getDraft(namespace: string, key: DraftKey) {
    requireNamespace(namespace);
    requireDraftKey(key);
    const storageKey = draftOutboxStorageKey(namespace, key);
    return runTransaction<DraftOutboxRecord | null>(
      this.database,
      "readwrite",
      null,
      ({ store, setResult, abort }) => {
        const request = store.get(storageKey);
        handleSuccess(request, abort, (value) => {
          if (value === undefined) return;
          if (isDraftOutboxRecord(value)) {
            setResult(value);
            return;
          }
          store.delete(storageKey);
        });
      },
    );
  }

  async putDraft(record: DraftOutboxRecord) {
    if (!isDraftOutboxRecord(record)) throw new Error("Draft outbox record is invalid.");
    await runTransaction(this.database, "readwrite", undefined, ({ store }) => {
      store.put(record);
    });
  }

  async deleteDraftIfMutation(
    namespace: string,
    key: DraftKey,
    requestId: string,
  ) {
    requireNamespace(namespace);
    requireDraftKey(key);
    if (!isMutationId(requestId)) throw new Error("Draft request ID is invalid.");
    const storageKey = draftOutboxStorageKey(namespace, key);
    return runTransaction(this.database, "readwrite", false, ({ store, setResult, abort }) => {
      const request = store.get(storageKey);
      handleSuccess(request, abort, (value) => {
        if (value === undefined) return;
        if (!isDraftOutboxRecord(value)) {
          store.delete(storageKey);
          return;
        }
        if (value.requestId !== requestId) return;
        store.delete(storageKey);
        setResult(true);
      });
    });
  }

  async listExamAnswers(namespace: string, sessionId: string) {
    requireNamespace(namespace);
    requireSessionId(sessionId);
    const records: ExamAnswerOutboxRecord[] = [];
    return runTransaction<ExamAnswerOutboxRecord[]>(
      this.database,
      "readwrite",
      records,
      ({ store, setResult, abort }) => {
        const request = store.index(NAMESPACE_KIND_SCOPE_INDEX)
          .openCursor([namespace, "exam-answer", sessionId]);
        handleSuccess(request, abort, (cursor) => {
          if (!cursor) {
            setResult(records.sort(compareRecords));
            return;
          }
          if (isExamAnswerOutboxRecord(cursor.value)) records.push(cursor.value);
          else cursor.delete();
          cursor.continue();
        });
      },
    );
  }

  async putExamAnswer(record: ExamAnswerOutboxRecord) {
    if (!isExamAnswerOutboxRecord(record)) {
      throw new Error("Exam answer outbox record is invalid.");
    }
    await runTransaction(this.database, "readwrite", undefined, ({ store }) => {
      store.put(record);
    });
  }

  async deleteExamAnswerIfMutation(
    namespace: string,
    sessionId: string,
    itemId: string,
    clientMutationId: string,
  ) {
    requireNamespace(namespace);
    requireSessionId(sessionId);
    if (!isExamItemId(itemId)) throw new Error("Exam item ID is invalid.");
    if (!isMutationId(clientMutationId)) throw new Error("Exam answer mutation ID is invalid.");
    const storageKey = examAnswerOutboxStorageKey(namespace, sessionId, itemId);
    return runTransaction(this.database, "readwrite", false, ({ store, setResult, abort }) => {
      const request = store.get(storageKey);
      handleSuccess(request, abort, (value) => {
        if (value === undefined) return;
        if (!isExamAnswerOutboxRecord(value)) {
          store.delete(storageKey);
          return;
        }
        if (value.clientMutationId !== clientMutationId) return;
        store.delete(storageKey);
        setResult(true);
      });
    });
  }

  async listExamEvents(namespace: string, sessionId: string) {
    requireNamespace(namespace);
    requireSessionId(sessionId);
    const records: ExamEventOutboxRecord[] = [];
    return runTransaction<ExamEventOutboxRecord[]>(
      this.database,
      "readwrite",
      records,
      ({ store, setResult, abort }) => {
        const request = store.index(NAMESPACE_KIND_SCOPE_INDEX)
          .openCursor([namespace, "exam-event", sessionId]);
        handleSuccess(request, abort, (cursor) => {
          if (!cursor) {
            setResult(records.sort(compareRecords));
            return;
          }
          if (isExamEventOutboxRecord(cursor.value)) records.push(cursor.value);
          else cursor.delete();
          cursor.continue();
        });
      },
    );
  }

  async putExamEvent(record: ExamEventOutboxRecord) {
    if (!isExamEventOutboxRecord(record)) throw new Error("Exam event outbox record is invalid.");
    await runTransaction(this.database, "readwrite", undefined, ({ store }) => {
      store.put(record);
    });
  }

  async deleteExamEvent(namespace: string, sessionId: string, clientEventId: string) {
    requireNamespace(namespace);
    requireSessionId(sessionId);
    if (!isClientEventId(clientEventId)) throw new Error("Exam client event ID is invalid.");
    const storageKey = examEventOutboxStorageKey(namespace, sessionId, clientEventId);
    await runTransaction(this.database, "readwrite", undefined, ({ store }) => {
      store.delete(storageKey);
    });
  }

  async clearExamSession(namespace: string, sessionId: string) {
    requireNamespace(namespace);
    requireSessionId(sessionId);
    await runTransaction(this.database, "readwrite", undefined, ({ store, abort }) => {
      const index = store.index(NAMESPACE_KIND_SCOPE_INDEX);
      deleteCursorMatches(index.openCursor([namespace, "exam-answer", sessionId]), abort);
      deleteCursorMatches(index.openCursor([namespace, "exam-event", sessionId]), abort);
    });
  }

  async clearNamespace(namespace: string) {
    requireNamespace(namespace);
    await runTransaction(this.database, "readwrite", undefined, ({ store, abort }) => {
      deleteCursorMatches(store.index(NAMESPACE_INDEX).openCursor(namespace), abort);
    });
  }

  async clearForeignNamespaces(currentNamespace: string) {
    requireNamespace(currentNamespace);
    await runTransaction(this.database, "readwrite", undefined, ({ store, abort }) => {
      const request = store.openCursor();
      handleSuccess(request, abort, (cursor) => {
        if (!cursor) return;
        if (!isBrowserOutboxRecord(cursor.value)
          || cursor.value.namespace !== currentNamespace) cursor.delete();
        cursor.continue();
      });
    });
  }

  async clearAll() {
    await runTransaction(this.database, "readwrite", undefined, ({ store }) => {
      store.clear();
    });
  }

  close() {
    this.database.close();
  }
}

export function openBrowserOutbox(
  factory: IDBFactory = indexedDB,
): Promise<BrowserOutboxRepository> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    let settled = false;
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: "storageKey" });
      store.createIndex(NAMESPACE_INDEX, "namespace", { unique: false });
      store.createIndex(
        NAMESPACE_KIND_SCOPE_INDEX,
        ["namespace", "kind", "scope"],
        { unique: false },
      );
    };
    request.onerror = () => {
      rejectOnce(request.error ?? indexedDbError("IndexedDB open failed."));
    };
    request.onblocked = () => {
      rejectOnce(new DOMException("IndexedDB open was blocked.", "InvalidStateError"));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => database.close();
      resolve(new IndexedDbBrowserOutbox(database));
    };
  });
}
