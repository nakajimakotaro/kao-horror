type Handler<T> = (payload: T) => void;

/** Minimal typed event emitter. */
export class Emitter<E extends { [K in keyof E]: unknown }> {
  private handlers = new Map<keyof E, Set<Handler<never>>>();

  on<K extends keyof E>(type: K, fn: Handler<E[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) (fn as Handler<E[K]>)(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}
