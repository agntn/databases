<script setup lang="ts">
const { samples, index, paused, step } = useLandingSamples();
</script>

<template>
  <div class="databases-landing not-prose">
    <LandingHero :samples="samples" :index="index" @step="step" @pause="paused = $event" />

    <LandingFeature
      title="Reads stay reads"
      to="/guide/read-only"
      link="How read-only works"
      :checks="[
        'A write inside a CTE fails like any other write',
        'ATTACH and a PRAGMA that sets something are writes too',
        'A second statement after the semicolon never runs',
      ]"
    >
      Telling a model to only read is a wish. Here the engine decides. SQLite checks every table,
      pragma and function while the statement is prepared, before a row moves. D1 gets the same
      check against a copy of its schema, so a write never leaves your machine. Postgres runs the
      read in a <code class="databases-code">READ ONLY</code> transaction. On the right is what the
      guard said about a few statements when this site was built.
      <template #visual>
        <LandingVerdicts />
      </template>
    </LandingFeature>

    <LandingFeature
      title="A name, not a password"
      to="/guide/connections"
      link="Connections"
      :checks="[
        'DATABASES_SHOP_URL becomes the connection shop',
        'Every answer shows the URL with *** for the password',
        'A path, a postgres:// URL or d1: works too',
      ]"
      reverse
    >
      An agent that types a connection string leaves it in the transcript. So you put the URL in
      the environment once, as <code class="databases-code">DATABASES_SHOP_URL</code>, and the
      agent only ever writes <code class="databases-code">shop</code>. The listing shows the
      connection with its password replaced. Any other reference is read by its shape, before
      anything connects.
      <template #visual>
        <LandingReferences />
      </template>
    </LandingFeature>

    <section class="databases-section">
      <div class="mx-auto w-full max-w-[var(--ui-container)] px-8 py-20 sm:px-12 lg:px-16">
        <LandingProviders />
      </div>
    </section>

    <section class="databases-section">
      <div class="mx-auto w-full max-w-[var(--ui-container)] px-8 py-20 sm:px-12 lg:px-16">
        <LandingStart />
      </div>
    </section>
  </div>
</template>
