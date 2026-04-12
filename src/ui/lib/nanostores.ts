// ============================================================================
// Nanostores — vendored core (atom, map, computed, batched).
//
// Source: https://github.com/nanostores/nanostores (MIT license)
// Version: 0.11.4 (vendored 2026-04-12)
//
// Only the primitives samsinn needs are included. Dev-only code (clean,
// cleanStores) is stripped. The lifecycle module is inlined (onMount only).
// ============================================================================

// === Types ===

export interface ReadableAtom<T> {
  readonly get: () => T
  readonly subscribe: (listener: Listener<T>) => Unsubscribe
  readonly listen: (listener: Listener<T>) => Unsubscribe
}

export interface WritableAtom<T> extends ReadableAtom<T> {
  set(value: T): void
  /** @internal */ value: T
  /** @internal */ lc: number
  /** @internal */ notify(oldValue: T, changedKey?: string): void
  /** @internal */ off(): void
  /** @internal */ events?: Record<number, unknown[]>
  /** @internal */ active?: boolean
  /** @internal */ starting?: boolean
}

export interface MapStore<T extends Record<string, unknown>> extends WritableAtom<T> {
  setKey<K extends keyof T>(key: K, value: T[K]): void
}

export type Listener<T> = (value: T, oldValue?: T, changedKey?: string) => void
export type Unsubscribe = () => void

// === Internal: listener queue (batches nested notifications) ===

let listenerQueue: unknown[] = []
let lqIndex = 0
const QUEUE_ITEMS_PER_LISTENER = 4
let epoch = 0

// === atom ===

export const atom = <T>(initialValue: T): WritableAtom<T> => {
  let listeners: Listener<T>[] = []

  const $atom: WritableAtom<T> = {
    get() {
      if (!$atom.lc) {
        $atom.listen(() => {})()
      }
      return $atom.value
    },
    lc: 0,
    listen(listener: Listener<T>): Unsubscribe {
      $atom.lc = listeners.push(listener)
      return () => {
        for (
          let i = lqIndex + QUEUE_ITEMS_PER_LISTENER;
          i < listenerQueue.length;
        ) {
          if (listenerQueue[i] === listener) {
            listenerQueue.splice(i, QUEUE_ITEMS_PER_LISTENER)
          } else {
            i += QUEUE_ITEMS_PER_LISTENER
          }
        }
        const index = listeners.indexOf(listener)
        if (~index) {
          listeners.splice(index, 1)
          if (!--$atom.lc) $atom.off()
        }
      }
    },
    notify(oldValue: T, changedKey?: string): void {
      epoch++
      const runListenerQueue = !listenerQueue.length
      for (const listener of listeners) {
        listenerQueue.push(listener, $atom.value, oldValue, changedKey)
      }
      if (runListenerQueue) {
        for (
          lqIndex = 0;
          lqIndex < listenerQueue.length;
          lqIndex += QUEUE_ITEMS_PER_LISTENER
        ) {
          ;(listenerQueue[lqIndex] as Listener<T>)(
            listenerQueue[lqIndex + 1] as T,
            listenerQueue[lqIndex + 2] as T,
            listenerQueue[lqIndex + 3] as string | undefined,
          )
        }
        listenerQueue.length = 0
      }
    },
    off() { /* overridden by onMount */ },
    set(newValue: T): void {
      const oldValue = $atom.value
      if (oldValue !== newValue) {
        $atom.value = newValue
        $atom.notify(oldValue)
      }
    },
    subscribe(listener: Listener<T>): Unsubscribe {
      const unbind = $atom.listen(listener)
      listener($atom.value)
      return unbind
    },
    value: initialValue,
  }

  return $atom
}

// === map ===

export const map = <T extends Record<string, unknown>>(initial: T = {} as T): MapStore<T> => {
  const $map = atom(initial) as unknown as MapStore<T>

  $map.setKey = function <K extends keyof T>(key: K, value: T[K]): void {
    const oldMap = $map.value
    if (typeof value === 'undefined' && key in $map.value) {
      $map.value = { ...$map.value }
      delete $map.value[key as string]
      $map.notify(oldMap, key as string)
    } else if ($map.value[key] !== value) {
      $map.value = { ...$map.value, [key]: value }
      $map.notify(oldMap, key as string)
    }
  }

  return $map
}

// === Lifecycle: onMount (inlined, minimal) ===

const MOUNT = 5
const UNMOUNT = 6
const STORE_UNMOUNT_DELAY = 1000

const onMount = <T>(
  $store: WritableAtom<T>,
  initialize: () => (() => void) | void,
): void => {
  const events = ($store.events = $store.events || {}) as Record<number, unknown[]>
  events[UNMOUNT] = events[UNMOUNT] || []

  const originListen = $store.listen.bind($store)
  $store.listen = (...args: [Listener<T>]): Unsubscribe => {
    if (!$store.lc && !$store.active) {
      $store.active = true
      const destroy = initialize()
      if (destroy) (events[UNMOUNT] as (() => void)[]).push(destroy)
    }
    return originListen(...args)
  }

  const originOff = $store.off.bind($store)
  $store.off = (): void => {
    originOff()
    setTimeout(() => {
      if ($store.active && !$store.lc) {
        $store.active = false
        for (const destroy of events[UNMOUNT] as (() => void)[]) destroy()
        events[UNMOUNT] = []
      }
    }, STORE_UNMOUNT_DELAY)
  }
}

// === computed / batched ===

const computedStore = <T, D extends ReadableAtom<unknown>[]>(
  stores: D | ReadableAtom<unknown>,
  cb: (...args: unknown[]) => T,
  isBatched?: boolean,
): ReadableAtom<T> => {
  const deps = (Array.isArray(stores) ? stores : [stores]) as ReadableAtom<unknown>[]

  let previousArgs: unknown[] | undefined
  let currentEpoch: number | undefined

  const $computed = atom<T>(undefined as T)

  const set = (): void => {
    if (currentEpoch === epoch) return
    currentEpoch = epoch
    const args = deps.map($s => $s.get())
    if (!previousArgs || args.some((arg, i) => arg !== previousArgs![i])) {
      previousArgs = args
      $computed.set(cb(...args))
      currentEpoch = epoch
    }
  }

  const originalGet = $computed.get.bind($computed)
  $computed.get = (): T => {
    set()
    return originalGet()
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const run = isBatched
    ? (): void => {
        clearTimeout(timer)
        timer = setTimeout(set)
      }
    : set

  onMount($computed, () => {
    const unbinds = deps.map($s => $s.listen(run))
    set()
    return () => {
      for (const unbind of unbinds) unbind()
    }
  })

  return $computed as ReadableAtom<T>
}

export const computed = <T, D extends ReadableAtom<unknown>[]>(
  stores: D | ReadableAtom<unknown>,
  fn: (...args: unknown[]) => T,
): ReadableAtom<T> => computedStore(stores, fn)

export const batched = <T, D extends ReadableAtom<unknown>[]>(
  stores: D | ReadableAtom<unknown>,
  fn: (...args: unknown[]) => T,
): ReadableAtom<T> => computedStore(stores, fn, true)
