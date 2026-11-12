<script lang="ts" setup>
/**
 * Overrides the Docus landing template with the hero zone of the site: brackets, crosses, the ID
 * strip, the two tone title, three readouts and the install line. Takumi reads no CSS variables,
 * so the palette from app.css is repeated as literals.
 */
import rootPackage from "../../../../package.json";
import { ENGINES, TOOLS } from "../../utils/databases";

defineProps<{ title?: string; description?: string }>();

const { version } = rootPackage;
const TAGLINE = "Schema and rows and plans from SQLite and Postgres and D1. The engine refuses the writes.";

/** The same three readouts as the hero, from the same sources. */
const METRICS = [
  {
    label: "Engines",
    value: String(ENGINES.length),
    unit: "",
    note: ENGINES.map((engine) => engine.name).join(" · "),
    accent: false,
  },
  {
    label: "Tools",
    value: String(TOOLS.length),
    unit: "",
    note: "one of them writes",
    accent: false,
  },
  {
    label: "Writes",
    value: "0",
    unit: "by default",
    note: "off until DATABASES_WRITE=1",
    accent: true,
  },
];

const LINE = "#262c35";
const CORNER = "#5b636d";
</script>

<template>
  <div
    class="w-full h-full flex flex-col items-center justify-center px-[64px] py-[48px]"
    style="background-color: #0b0d10; font-family: &quot;Figtree&quot;; color: #d5e4ee"
  >
    <div
      class="absolute top-0 left-[150px] w-[900px] h-[420px]"
      style="
        background-image: radial-gradient(
          ellipse at top,
          rgba(252, 211, 77, 0.16) 0%,
          rgba(252, 211, 77, 0.04) 45%,
          transparent 70%
        );
      "
    />

    <!-- The zone's open brackets with a thick mark near the top, crosses above the corners. -->
    <div
      class="absolute top-[44px] bottom-[44px] left-[40px] w-[14px] flex"
      :style="{
        borderLeft: `1px solid ${LINE}`,
        borderTop: `1px solid ${LINE}`,
        borderBottom: `1px solid ${LINE}`,
      }"
    />
    <div
      class="absolute top-[44px] bottom-[44px] right-[40px] w-[14px] flex"
      :style="{
        borderRight: `1px solid ${LINE}`,
        borderTop: `1px solid ${LINE}`,
        borderBottom: `1px solid ${LINE}`,
      }"
    />
    <div
      class="absolute top-[64px] left-[45px] w-[3px] h-[26px]"
      :style="{ backgroundColor: CORNER }"
    />
    <div
      class="absolute top-[64px] right-[45px] w-[3px] h-[26px]"
      :style="{ backgroundColor: CORNER }"
    />
    <p
      class="absolute m-0 top-[30px] left-[33px] text-[18px]"
      :style="{ fontFamily: 'Fira Code', color: CORNER }"
    >
      +
    </p>
    <p
      class="absolute m-0 top-[30px] right-[33px] text-[18px]"
      :style="{ fontFamily: 'Fira Code', color: CORNER }"
    >
      +
    </p>

    <div
      class="flex items-center text-[16px]"
      :style="{ fontFamily: 'Fira Code', color: '#a5b0bc', border: `1px solid ${LINE}` }"
    >
      <p class="m-0 px-[10px] py-[4px]" style="background-color: #1f242c; color: #d5e4ee">ID</p>
      <p class="m-0 px-[14px] py-[4px]">@agntn/databases&#160;&#160;/&#160;&#160;v{{ version }}</p>
    </div>

    <div class="flex items-baseline mt-[30px]">
      <h1
        class="m-0 text-[58px] font-medium leading-[1.05] tracking-[-0.03em]"
        style="color: #f0f4f8"
      >
        Look at the data.
      </h1>
      <h1
        class="m-0 ml-[24px] text-[58px] font-medium leading-[1.05] tracking-[-0.03em]"
        style="color: #fcd34d"
      >
        Don't touch it.
      </h1>
    </div>
    <p
      class="m-0 mt-[18px] text-[25px] leading-[1.4] text-center max-w-[860px]"
      style="color: #8a97a5"
    >
      {{ TAGLINE }}
    </p>

    <div class="flex mt-[34px] w-[760px]">
      <div
        v-for="(metric, index) in METRICS"
        :key="metric.label"
        class="flex flex-col flex-1 px-[22px]"
        :style="{ borderLeft: index === 0 ? 'none' : `1px solid ${LINE}` }"
      >
        <p
          class="m-0 text-[14px] tracking-[0.1em] uppercase"
          style="font-family: &quot;Fira Code&quot;; color: #7d8590"
        >
          {{ metric.label }}
        </p>
        <div class="flex items-baseline mt-[6px]">
          <p
            class="m-0 text-[40px] leading-none"
            :style="{ fontFamily: 'Fira Code', color: metric.accent ? '#fcd34d' : '#f0f4f8' }"
          >
            {{ metric.value }}
          </p>
          <p
            v-if="metric.unit"
            class="m-0 ml-[10px] text-[18px]"
            style="font-family: &quot;Fira Code&quot;; color: #7d8590"
          >
            {{ metric.unit }}
          </p>
        </div>
        <p
          class="m-0 mt-[8px] text-[14px] tracking-[0.04em]"
          style="font-family: &quot;Fira Code&quot;; color: #7d8590"
        >
          {{ metric.note }}
        </p>
      </div>
    </div>

    <div
      class="flex items-center mt-[34px] px-[12px] py-[8px] text-[18px]"
      :style="{ fontFamily: 'Fira Code', color: '#f0f4f8', border: `1px dashed ${LINE}` }"
    >
      <p
        class="m-0 mr-[14px] px-[8px] py-[2px] text-[13px] tracking-[0.1em]"
        :style="{ color: '#a5b0bc', border: `1px solid ${LINE}` }"
      >
        INSTALL
      </p>
      <p class="m-0" style="color: #7d8590">$</p>
      <p class="m-0 ml-[10px]">pnpm add @agntn/databases</p>
    </div>
  </div>
</template>
