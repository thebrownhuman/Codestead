import { RunnerError } from "./errors.js";

interface QueueEntry<T> {
  readonly id: string;
  readonly work: () => Promise<T>;
  readonly onStart?: () => void;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

export interface EnqueuedWork<T> {
  readonly position: number;
  readonly completion: Promise<T>;
}

export class FifoWorkQueue<T> {
  readonly #concurrency: number;
  readonly #maxDepth: number;
  readonly #pending: QueueEntry<T>[] = [];
  #active = 0;
  #pumpScheduled = false;

  constructor(concurrency = 2, maxDepth = 100) {
    if (!Number.isInteger(concurrency) || concurrency <= 0) {
      throw new RangeError("concurrency must be a positive integer");
    }
    if (!Number.isInteger(maxDepth) || maxDepth < concurrency) {
      throw new RangeError("maxDepth must be at least concurrency");
    }
    this.#concurrency = concurrency;
    this.#maxDepth = maxDepth;
  }

  get active(): number {
    return this.#active;
  }

  get depth(): number {
    return this.#pending.length;
  }

  get capacity(): number {
    return this.#maxDepth;
  }

  get hasCapacity(): boolean {
    return this.#pending.length + this.#active < this.#maxDepth;
  }

  enqueue(
    id: string,
    work: () => Promise<T>,
    onStart?: () => void,
  ): EnqueuedWork<T> {
    if (!this.hasCapacity) {
      throw new RunnerError(
        "QUEUE_FULL",
        "runner queue is full",
        429,
        true,
      );
    }

    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const completion = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const position = this.#pending.length + 1;
    const entry: QueueEntry<T> = {
      id,
      work,
      ...(onStart === undefined ? {} : { onStart }),
      resolve,
      reject,
    };
    this.#pending.push(entry);
    this.schedulePump();
    return { position, completion };
  }

  positionOf(id: string): number | null {
    const index = this.#pending.findIndex((entry) => entry.id === id);
    return index === -1 ? null : index + 1;
  }

  private schedulePump(): void {
    if (this.#pumpScheduled) {
      return;
    }
    this.#pumpScheduled = true;
    queueMicrotask(() => {
      this.#pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    while (
      this.#active < this.#concurrency &&
      this.#pending.length > 0
    ) {
      const entry = this.#pending.shift();
      if (entry === undefined) {
        break;
      }
      this.#active += 1;
      try {
        entry.onStart?.();
      } catch (error) {
        this.#active -= 1;
        entry.reject(error);
        continue;
      }
      void entry
        .work()
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.#active -= 1;
          this.schedulePump();
        });
    }
  }
}
