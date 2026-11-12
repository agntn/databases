import recorded from "../data/samples.json";

/** One recorded call of `databases_query`: the statement, its answer and the text the tool wrote. */
export interface Sample {
  readonly id: string;
  readonly title: string;
  readonly sql: string;
  readonly params?: readonly (string | number | boolean | null)[];
  readonly limit?: number;
  readonly text: string;
  readonly result?: {
    readonly provider: string;
    readonly columns: readonly { name: string; type?: string }[];
    readonly rows: readonly (readonly unknown[])[];
    readonly more: boolean;
    readonly cut: boolean;
  };
  readonly error?: { readonly code: string };
}

/** The calls the hero walks through. Built by `scripts/samples.mjs`. */
export const SAMPLES = recorded.queries as readonly Sample[];

/**
 * One clock for the hero, paused on hover and focus, never started under reduced motion. Previous
 * and next always work.
 */
export function useLandingSamples() {
  const tick = ref(0);
  const paused = ref(false);
  const index = computed(() => tick.value % SAMPLES.length);
  const sample = computed(() => SAMPLES[index.value]!);

  let timer: number | undefined;

  /** Wraps at both ends, so previous on the first sample lands on the last one. */
  function step(delta: number) {
    tick.value = (tick.value + delta + SAMPLES.length) % SAMPLES.length;
  }

  function stopWalk() {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  }

  function startWalk() {
    stopWalk();
    if (!import.meta.client || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    timer = window.setInterval(() => {
      if (!paused.value && !document.hidden) step(1);
    }, 5200);
  }

  onMounted(startWalk);
  onUnmounted(stopWalk);

  return { samples: SAMPLES, sample, index, paused, step };
}
