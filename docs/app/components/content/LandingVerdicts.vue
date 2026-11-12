<script setup lang="ts">
import { VERDICTS } from "../../utils/databases";

/** Two reads and three refusals out of the recorded set, so the panel stays at five rows. */
const SHOWN = [0, 2, 4, 5, 7].map((index) => VERDICTS[index]!).filter(Boolean);

/**
 * The verdict as a word: both checks agree in every recorded case, and the panel says so.
 *
 * @param {{ sqlite: string; d1: string }} entry - Verdicts for the file and for D1.
 * @returns {string} `read`, `refused`, or both when they differ.
 */
function word(entry: { sqlite: string; d1: string }): string {
  const name = (code: string) => (code === "ok" ? "read" : code);
  return entry.sqlite === entry.d1 ? name(entry.sqlite) : `${name(entry.sqlite)} / ${name(entry.d1)}`;
}
</script>

<template>
  <section class="tool-console landing-verdicts" aria-label="Statements and what the read guard said">
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>

    <header class="console-bar">
      <span class="console-title"><span class="console-tag">Log</span>prepare(sql)</span>
      <span class="console-meta">SQLite · D1</span>
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true"><span class="console-cursor" /></div>

    <div class="verdicts-subject">
      <div class="verdicts-identity">
        <ConsoleReticle icon="i-lucide-shield-check" />
        <div class="verdicts-name">
          <span class="console-label">Guard / <span class="console-label-key">setAuthorizer</span></span>
          <h3>Decided before a row is read</h3>
          <p class="verdicts-note">The same check for a local file and for a D1 database.</p>
        </div>
      </div>
    </div>

    <dl class="console-readout-rows console-animate verdicts-rows">
      <div v-for="(entry, position) in SHOWN" :key="entry.sql" :style="{ animationDelay: `${position * 45}ms` }">
        <dt :class="word(entry) === 'read' ? 'console-accent' : 'verdicts-refused'">{{ word(entry) }}</dt>
        <dd>
          <UTooltip :text="entry.sql"><span class="verdicts-line" tabindex="0">{{ entry.sql }}</span></UTooltip>
        </dd>
      </div>
    </dl>

    <footer class="console-footer console-footer-plain">
      <span>Run through the library when the site was built</span>
    </footer>
  </section>
</template>

<style scoped>
.verdicts-subject {
  position: relative;
  padding: 18px 20px 4px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'%3E%3Cpath d='M16 18h4m-2-2v4' fill='none' stroke='%23818a94' stroke-opacity='.1'/%3E%3C/svg%3E");
  background-size: 36px 36px;
  background-position: 24px 20px;
}
.verdicts-identity {
  position: relative;
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 16px;
  align-items: center;
}
.verdicts-name {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.verdicts-name h3 {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 22px;
  font-weight: 500;
  line-height: 1.2;
  color: var(--ui-text-highlighted);
}
.verdicts-note {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.verdicts-rows {
  padding: 16px 20px 18px;
}
.landing-verdicts .verdicts-rows > div {
  grid-template-columns: 5.5rem minmax(0, 1fr);
}
.landing-verdicts .verdicts-rows dt {
  text-transform: none;
  letter-spacing: 0.02em;
}
.verdicts-refused {
  color: #ff7b72;
}
.verdicts-line {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}
@media (width < 400px) {
  .verdicts-rows,
  .verdicts-subject {
    padding-inline: 14px;
  }
  .verdicts-identity {
    grid-template-columns: 64px minmax(0, 1fr);
    gap: 12px;
  }
}
</style>
