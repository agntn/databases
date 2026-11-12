<script setup lang="ts">
import type { Sample } from "../../composables/useLandingSamples";
import { DATABASE, engineView } from "../../utils/databases";

const props = defineProps<{ samples: readonly Sample[]; index: number }>();
const emit = defineEmits<{ step: [delta: number]; pause: [paused: boolean] }>();

const sample = computed(() => props.samples[props.index]!);
const engine = engineView("sqlite");
const file = DATABASE.split("/").at(-1) ?? DATABASE;
const call = computed(() => `databases_query("${file}", ${JSON.stringify(sample.value.sql)})`);

/**
 * What the answer comes down to in one line: the first row, or why there is none.
 *
 * @param {Sample} entry - A recorded call.
 * @returns {string} The line.
 */
function headline(entry: Sample): string {
  if (entry.error) return entry.text.split(" [")[0] ?? entry.text;
  const first = entry.result?.rows[0];
  return first ? first.map((cell) => String(cell)).join(" · ") : "No rows";
}

/**
 * The rows of the readout: the verdict in the accent, then what came back.
 *
 * @param {Sample} entry - A recorded call.
 * @returns {{ label: string; value: string; accent?: boolean }[]} Label and value pairs.
 */
function rows(entry: Sample): { label: string; value: string; accent?: boolean }[] {
  if (entry.error) {
    return [
      { label: "verdict", value: entry.error.code, accent: true },
      { label: "engine", value: engine.key },
      { label: "sent", value: "nothing ran" },
      { label: "rows", value: "none" },
      { label: "file", value: "unchanged" },
    ];
  }
  const result = entry.result!;
  return [
    { label: "verdict", value: "read", accent: true },
    { label: "engine", value: result.provider },
    { label: "columns", value: result.columns.map((column) => column.name).join(", ") },
    { label: "rows", value: String(result.rows.length) },
    { label: "more", value: result.more ? `yes, past limit ${entry.limit ?? 50}` : "no" },
  ];
}
</script>

<template>
  <section
    class="tool-console console-wide landing-query"
    aria-label="Recorded queries, as the tool answers them"
    @mouseenter="emit('pause', true)"
    @mouseleave="emit('pause', false)"
    @focusin="emit('pause', true)"
    @focusout="emit('pause', false)"
  >
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>

    <header class="console-bar">
      <UTooltip :text="call">
        <span class="console-title query-call" tabindex="0"
          ><span class="console-tag">Call</span>databases_query
          <Transition name="databases-roll" mode="out-in"
            ><span :key="sample.id" class="databases-roll-slot tok-str">{{ file }}</span></Transition
          ></span
        >
      </UTooltip>
      <span class="console-meta"
        >{{ engine.name }} · {{ String(index + 1).padStart(2, "0") }} /
        {{ String(samples.length).padStart(2, "0") }}</span
      >
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true">
      <span :key="sample.id" class="console-cursor" />
    </div>

    <div class="console-band console-subject-band query-subject">
      <div :key="sample.id" class="console-scan" aria-hidden="true" />
      <div class="query-left">
        <div class="console-identity-block">
          <ConsoleReticle :key="sample.id" :icon="sample.error ? 'i-lucide-shield-x' : engine.icon" />
          <!-- Every sample sits in the same cell, hidden, so the band keeps the tallest one's height. -->
          <div class="query-names">
            <div
              v-for="other in samples"
              :key="other.id"
              class="console-name"
              :class="{ 'query-sizer': other.id !== sample.id }"
              :aria-hidden="other.id !== sample.id ? 'true' : undefined"
            >
              <span class="console-label"
                >Query / <span class="console-label-key">{{ file }}</span></span
              >
              <h3>{{ other.title }}</h3>
              <p class="console-about query-headline">{{ headline(other) }}</p>
            </div>
          </div>
        </div>

        <div class="query-sql">
          <p class="console-label console-rule-title">
            <span>SQL <span aria-hidden="true">[ as the agent sent it ]</span></span>
            <span class="console-mark" aria-hidden="true" />
          </p>
          <p :key="sample.id" class="query-text">{{ sample.sql }}</p>
        </div>
      </div>

      <div class="console-readout">
        <svg class="console-link" viewBox="0 0 32 40" fill="none" aria-hidden="true">
          <circle cx="3" cy="12" r="2.5" />
          <path d="M5.5 12H14L22 20H32" />
        </svg>
        <dl :key="sample.id" class="console-readout-rows console-animate">
          <div v-for="(row, position) in rows(sample)" :key="row.label" :style="{ animationDelay: `${position * 45}ms` }">
            <dt>{{ row.label }}</dt>
            <dd :class="{ 'console-accent': row.accent }">
              <UTooltip :text="row.value">
                <span class="query-line" tabindex="0">{{ row.value }}</span>
              </UTooltip>
            </dd>
          </div>
        </dl>
        <div class="console-gauge" :aria-label="`Query ${index + 1} of ${samples.length}`">
          <span class="console-ticks" aria-hidden="true">
            <span
              v-for="(other, position) in samples"
              :key="other.id"
              :class="other.id === sample.id ? 'console-tick-open' : 'console-tick-closed'"
              :style="{ animationDelay: `${position * 12}ms` }"
            />
          </span>
          <span class="console-gauge-read">query {{ index + 1 }} / {{ samples.length }}</span>
        </div>
      </div>
    </div>

    <ConsoleResponse
      :title="`databases_query · ${sample.title}`"
      :text="sample.text"
      label="Full tool response"
      source="content[0].text"
      description="What databases_query hands a model for this statement: where the rows came from, the columns and their types, one JSON array per row."
    />

    <footer class="console-footer console-footer-plain">
      <NuxtLink to="/guide/read-only" class="query-link"
        ><span aria-hidden="true">→ </span>Read only<span> · /guide/read-only</span></NuxtLink
      >
      <div class="console-controls" aria-label="Sample queries">
        <UButton
          color="neutral"
          variant="subtle"
          square
          icon="i-lucide-chevron-left"
          aria-label="Previous query"
          @click="emit('step', -1)"
        />
        <span>Query</span>
        <UButton
          color="neutral"
          variant="subtle"
          square
          icon="i-lucide-chevron-right"
          aria-label="Next query"
          @click="emit('step', 1)"
        />
      </div>
    </footer>
  </section>
</template>

<style scoped>
.query-call {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.query-names {
  display: grid;
  min-width: 0;
}
.query-names > .console-name {
  grid-area: 1 / 1;
  min-width: 0;
}
.query-sizer {
  visibility: hidden;
}
.query-headline {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.query-line {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.landing-query :deep(.console-readout-rows > div) {
  grid-template-columns: 6rem minmax(0, 1fr);
}
.landing-query :deep(.console-readout-rows dt) {
  text-transform: none;
  letter-spacing: 0.02em;
}
.query-left {
  display: grid;
  gap: 18px;
  min-width: 0;
}
.query-sql {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.query-sql > .console-rule-title {
  margin: 0 0 2px;
}
/* Four lines for every sample, so the instrument never changes height between queries. */
.query-text {
  height: calc(1.7em * 4 + 20px);
  margin: 0;
  padding: 10px 12px;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.7;
  color: var(--ui-text);
  overflow-wrap: anywhere;
  background: var(--ui-bg);
  box-shadow: inset 0 0 0 1px var(--console-line);
}
@container (width >= 46rem) {
  .query-subject > .console-readout {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    align-self: stretch;
  }
  .query-subject :deep(.console-readout-rows) {
    grid-auto-rows: minmax(2.5rem, 1fr);
  }
  .query-subject :deep(.console-readout-rows > div) {
    align-items: center;
  }
}
.query-link {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-highlighted);
}
.query-link > span:last-child {
  color: var(--ui-text-dimmed);
}
.query-link:hover {
  color: var(--console-accent);
}
.query-link:focus-visible {
  outline: 1px solid var(--ui-primary);
  outline-offset: 3px;
}
@media (width < 640px) {
  .query-sql > .console-rule-title > .console-mark {
    display: none;
  }
}
</style>
