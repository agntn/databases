<script setup lang="ts">
import { REFERENCES } from "../../utils/databases";
</script>

<template>
  <section class="tool-console landing-references" aria-label="References and what they open">
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>

    <header class="console-bar">
      <span class="console-title"><span class="console-tag">Call</span>parseReference(database)</span>
      <span class="console-meta">no connection yet</span>
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true"><span class="console-cursor" /></div>

    <div class="references-subject">
      <div class="references-identity">
        <ConsoleReticle icon="i-lucide-key-round" />
        <div class="references-name">
          <span class="console-label">Reference / <span class="console-label-key">database</span></span>
          <h3>It reads the shape</h3>
          <p class="references-note">The agent writes a name. The password stays in the environment.</p>
        </div>
      </div>
    </div>

    <dl class="console-readout-rows console-animate references-rows">
      <div v-for="(entry, position) in REFERENCES" :key="entry.reference" :style="{ animationDelay: `${position * 45}ms` }">
        <dt :class="{ 'console-accent': entry.name }">{{ entry.provider }}</dt>
        <dd>
          <UTooltip :text="`${entry.reference} → ${entry.label}`"
            ><span class="references-line" tabindex="0">{{ entry.reference }}</span></UTooltip
          >
        </dd>
      </div>
    </dl>

    <footer class="console-footer console-footer-plain">
      <span>Parsed by the library when the site was built</span>
    </footer>
  </section>
</template>

<style scoped>
.references-subject {
  position: relative;
  padding: 18px 20px 4px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'%3E%3Cpath d='M16 18h4m-2-2v4' fill='none' stroke='%23818a94' stroke-opacity='.1'/%3E%3C/svg%3E");
  background-size: 36px 36px;
  background-position: 24px 20px;
}
.references-identity {
  position: relative;
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 16px;
  align-items: center;
}
.references-name {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.references-name h3 {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 22px;
  font-weight: 500;
  line-height: 1.2;
  color: var(--ui-text-highlighted);
}
.references-note {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.references-rows {
  padding: 16px 20px 18px;
}
.landing-references .references-rows > div {
  grid-template-columns: 5.5rem minmax(0, 1fr);
}
.landing-references .references-rows dt {
  text-transform: none;
  letter-spacing: 0.02em;
}
.references-line {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}
@media (width < 400px) {
  .references-rows,
  .references-subject {
    padding-inline: 14px;
  }
  .references-identity {
    grid-template-columns: 64px minmax(0, 1fr);
    gap: 12px;
  }
}
</style>
