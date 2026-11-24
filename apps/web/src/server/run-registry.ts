export interface RunRegistry {
  register(runId: string): AbortController;
  abort(runId: string, reason: string): boolean;
  unregister(runId: string): void;
  has(runId: string): boolean;
}

export function createRunRegistry(): RunRegistry {
  const active = new Map<string, AbortController>();
  return {
    register(runId) {
      const controller = new AbortController();
      active.set(runId, controller);
      return controller;
    },
    abort(runId, reason) {
      const controller = active.get(runId);
      if (controller === undefined) return false;
      controller.abort(new Error(reason));
      active.delete(runId);
      return true;
    },
    unregister(runId) {
      active.delete(runId);
    },
    has(runId) {
      return active.has(runId);
    },
  };
}

const holder = globalThis as typeof globalThis & { __delegateRunRegistry?: RunRegistry };

export function runRegistry(): RunRegistry {
  holder.__delegateRunRegistry ??= createRunRegistry();
  return holder.__delegateRunRegistry;
}
