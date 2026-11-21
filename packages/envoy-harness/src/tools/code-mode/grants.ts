/**
 * Which deferred tool namespaces a code_mode cell may invoke.
 */

export interface CodeModeGrantStore {
  grant(names: ReadonlyArray<string>): void;
  has(name: string): boolean;
  list(): string[];
  clear(): void;
}

export function createInMemoryCodeModeGrantStore(): CodeModeGrantStore {
  const set = new Set<string>();
  return {
    grant(names) {
      for (const n of names) {
        if (n.length > 0) set.add(n);
      }
    },
    has(name) {
      return set.has(name);
    },
    list() {
      return [...set].sort();
    },
    clear() {
      set.clear();
    },
  };
}
