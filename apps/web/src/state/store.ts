// 极简 store：一个可订阅的状态容器 + useSyncExternalStore 钩子。不引入状态库。
import { useSyncExternalStore } from 'react';

export interface Store<T> {
  get(): T;
  set(updater: (s: T) => T): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(updater) {
      const next = updater(state);
      if (next === state) return;
      state = next;
      for (const fn of [...subs]) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** 选择器必须返回稳定引用（状态里的原值或对象），不要在选择器里新建对象或数组 */
export function useStore<T, S>(store: Store<T>, selector: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()), () => selector(store.get()));
}
