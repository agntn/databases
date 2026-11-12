<script setup lang="ts">
import { spellOut } from "../../utils/format";
import { ENGINES } from "../../utils/databases";

/** Where each engine lives, in the words of a reference. */
const PLACES: Readonly<Record<string, string>> = {
  sqlite: "a file on this machine",
  postgres: "a server you name by URL",
  d1: "Cloudflare, over the REST API",
};
</script>

<template>
  <div class="tool-console console-wide landing-registry">
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>
    <header class="console-bar">
      <span class="console-title"><span class="console-tag">Call</span>listProviders()</span>
      <span class="console-meta">{{ ENGINES.length }} engines</span>
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true" />

    <div class="registry-body">
      <div class="registry-copy">
        <h2 class="registry-title">Three engines, one set of tools</h2>
        <p class="registry-lead">
          Each engine keeps its own dialect. SQLite and D1 speak SQLite, Postgres speaks Postgres.
          What changes is how a write gets stopped, and every engine page says exactly how.
        </p>
      </div>

      <div class="registry-band">
        <p class="console-label console-rule-title">
          <span>Engines <span aria-hidden="true">[ {{ spellOut(ENGINES.length) }} built in ]</span></span>
          <span class="console-mark" aria-hidden="true" />
        </p>
        <ul class="registry-cells">
          <li v-for="(engine, place) in ENGINES" :key="engine.key">
            <UTooltip :text="engine.readOnly">
              <NuxtLink :to="engine.to" class="registry-cell" :data-first="place === 0 ? '' : undefined">
                <UIcon :name="engine.icon" class="registry-glyph" aria-hidden="true" />
                <span class="registry-name">{{ engine.key }}</span>
                <span class="registry-host">{{ PLACES[engine.key] ?? engine.reference }}</span>
                <span class="registry-node" aria-hidden="true" />
              </NuxtLink>
            </UTooltip>
          </li>
        </ul>
      </div>
    </div>

    <footer class="console-footer console-footer-plain">
      <span>Read from the registry</span>
      <NuxtLink to="/providers" class="registry-link"><span aria-hidden="true">→ </span>every engine</NuxtLink>
    </footer>
  </div>
</template>

<style scoped>
.registry-body {
  display: grid;
  gap: 18px;
  padding: 24px 24px 26px;
}
.registry-copy {
  display: grid;
  gap: 10px;
  max-width: 44rem;
}
.registry-title {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 28px;
  font-weight: 500;
  line-height: 1.2;
  letter-spacing: -0.01em;
  color: var(--ui-text-highlighted);
}
.registry-lead {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.65;
  color: var(--ui-text-muted);
}
.registry-band {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.registry-band > .console-rule-title {
  margin: 0;
}
.registry-cells {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr));
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.registry-cell {
  display: grid;
  grid-template-columns: 16px minmax(0, auto) minmax(0, 1fr) 7px;
  gap: 10px;
  align-items: center;
  height: 36px;
  padding: 0 12px;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 36px;
  color: var(--ui-text-muted);
  background: var(--ui-bg);
  box-shadow: inset 0 0 0 1px var(--console-line);
  transition: color 0.15s ease;
}
.registry-glyph {
  width: 14px;
  height: 14px;
  color: var(--ui-text-dimmed);
}
.registry-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-highlighted);
}
.registry-host {
  overflow: hidden;
  font-size: 11px;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-dimmed);
}
.registry-node {
  width: 7px;
  height: 7px;
  box-shadow: inset 0 0 0 1px var(--console-corner);
}
.registry-cell[data-first] .registry-node {
  background: var(--console-accent);
  box-shadow: none;
}
.registry-cell:hover {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--console-accent) 55%, transparent);
}
.registry-cell:hover .registry-glyph {
  color: var(--console-accent);
}
.registry-cell:focus-visible {
  outline: 1px solid var(--ui-primary);
  outline-offset: 2px;
}
.registry-link {
  color: var(--ui-text-highlighted);
}
.registry-link:hover {
  color: var(--console-accent);
}
.registry-link:focus-visible {
  outline: 1px solid var(--ui-primary);
  outline-offset: 3px;
}
@media (width < 640px) {
  .registry-body {
    padding: 18px 14px 20px;
  }
  .registry-title {
    font-size: 24px;
  }
  .registry-band > .console-rule-title > .console-mark {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .registry-cell {
    transition: none;
  }
}
</style>
