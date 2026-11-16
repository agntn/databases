<script setup lang="ts">
import rootPackage from "../../../../package.json";
import type { Sample } from "../../composables/useLandingSamples";
import { ENGINES, TOOLS } from "../../utils/databases";

defineProps<{ samples: readonly Sample[]; index: number }>();
const emit = defineEmits<{ step: [delta: number]; pause: [paused: boolean] }>();

const INSTALL = "pnpm add @agntn/databases";
/** Tools that may change data. They stay off until the server says otherwise. */
const WRITING = TOOLS.filter((tool) => tool.effect !== "read");
const { copied, copy } = useCopied();
</script>

<template>
  <header class="databases-hero hero-page">
    <div class="hero-zone">
      <span class="hero-cross hero-cross-tl" aria-hidden="true">+</span>
      <span class="hero-cross hero-cross-tr" aria-hidden="true">+</span>
      <span class="hero-bracket hero-bracket-l" aria-hidden="true" />
      <span class="hero-bracket hero-bracket-r" aria-hidden="true" />

      <p class="console-id">
        <span class="console-id-tag">ID</span>
        <span>@agntn/databases</span>
        <span class="console-id-sep" aria-hidden="true">/</span>
        <span>v{{ rootPackage.version }}</span>
      </p>

      <h1 class="hero-title">Look at the data. <span>Don't touch it.</span></h1>
      <p class="hero-lead">
        Handing an agent a psql shell and hoping it only types SELECT is a plan. Not a good one.
        Here the agent gets the schema, the rows and the plan, and the engine itself refuses a
        write. Even the one hiding in a CTE.
      </p>

      <dl class="hero-metrics">
        <div>
          <dt>Engines</dt>
          <dd>{{ ENGINES.length }}</dd>
          <dd class="hero-metric-sub">{{ ENGINES.map((engine) => engine.name).join(" · ") }}</dd>
        </div>
        <div>
          <dt>Tools</dt>
          <dd>{{ TOOLS.length }}</dd>
          <dd class="hero-metric-sub">schema, rows, plans, one write tool</dd>
        </div>
        <div>
          <dt>Writes by default</dt>
          <dd class="hero-metric-accent">{{ WRITING.length }}</dd>
          <dd class="hero-metric-sub">write tool, enabled by default</dd>
        </div>
      </dl>

      <div class="console-actions">
        <UButton to="/guide" color="primary" variant="solid" trailing-icon="i-lucide-arrow-right" label="Get started" />
        <UButton
          to="https://github.com/agntn/databases"
          target="_blank"
          color="neutral"
          variant="outline"
          icon="i-simple-icons-github"
          label="Star on GitHub"
        />
      </div>
      <div class="console-install">
        <span class="console-install-tag">Install</span>
        <code><span class="console-install-prompt">$</span> {{ INSTALL }}</code>
        <UButton
          color="neutral"
          variant="subtle"
          :icon="copied === 'install' ? 'i-lucide-check' : 'i-lucide-copy'"
          :aria-label="copied === 'install' ? 'Copied' : 'Copy install command'"
          @click="copy('install', INSTALL)"
        />
      </div>
    </div>

    <!-- One recorded query at a time, and what the tool answered. -->
    <div class="hero-instrument">
      <svg class="hero-circuit" viewBox="0 0 160 56" aria-hidden="true">
        <path class="hero-circuit-rail" d="M80 0V16L96 32V56" />
        <path :key="index" class="hero-circuit-live" d="M80 0V16L96 32V56" pathLength="1" />
        <path class="hero-circuit-seg" d="M96 38V48" />
        <rect class="hero-circuit-node" x="92.5" y="52.5" width="7" height="7" />
      </svg>
      <span class="hero-circuit-tag" aria-hidden="true">query(sql)</span>
      <LandingQuery :samples="samples" :index="index" @step="emit('step', $event)" @pause="emit('pause', $event)" />
    </div>
  </header>
</template>
