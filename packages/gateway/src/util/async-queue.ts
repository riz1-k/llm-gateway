const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * Unbounded single-consumer async queue bridging push-style callbacks (event subscriptions) to
 * pull-style `for await` consumers.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter:
    { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void } | undefined;
  private closed = false;
  private failure: { error: unknown } | undefined;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w.resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiter && this.items.length === 0) {
      const w = this.waiter;
      this.waiter = undefined;
      w.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = { error };
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w.reject(asError(error));
    }
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.failure) return Promise.reject(asError(this.failure.error));
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}
