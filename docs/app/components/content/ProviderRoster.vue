<script setup lang="ts">
import type { TableColumn } from "@nuxt/ui";
import { ENGINES } from "../../utils/databases";
import { ROSTER_CLASS, ROSTER_TABLE_UI } from "../../utils/roster";

/** Keep to one engine, for an engine's own page. Without it the roster lists every engine. */
const props = defineProps<{ engine?: string }>();

interface Row {
  readonly key: string;
  readonly title: string;
  readonly icon: string;
  readonly to: string;
  readonly reference: string;
  readonly readOnly: string;
  readonly place: number;
}

const rows = ENGINES.filter((engine) => props.engine === undefined || engine.key === props.engine).map<Row>((engine) => ({
  key: engine.key,
  title: engine.title,
  icon: engine.icon,
  to: engine.to,
  reference: engine.reference,
  readOnly: engine.readOnly,
  place: ENGINES.findIndex((other) => other.key === engine.key) + 1,
}));

const sorting = ref<{ id: string; desc: boolean }[]>([]);
const roster = useTemplateRef<HTMLElement>("roster");
useRosterFlip(
  () => roster.value,
  () => sorting.value,
);

const columns: TableColumn<Row>[] = [
  { accessorKey: "key", header: "Provider", sortingFn: "text", meta: { class: { th: "w-[11rem]" } } },
  { accessorKey: "title", header: "Engine", sortingFn: "text", meta: { class: { th: "w-[9rem]" } } },
  { accessorKey: "reference", header: "Reference", meta: { class: { td: "min-w-0" } } },
  { accessorKey: "readOnly", header: "Read only", meta: { class: { th: "w-[12rem]" } } },
];

const order = computed(() => {
  const [first] = sorting.value;
  if (first === undefined) return "registry order";
  const label = columns.find((column) => "accessorKey" in column && column.accessorKey === first.id)?.header;
  return `by ${String(label).toLowerCase()} ${first.desc ? "descending" : "ascending"}`;
});
</script>

<template>
  <section ref="roster" class="roster not-prose my-6" aria-label="Providers">
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>
    <header :class="ROSTER_CLASS.bar">
      <span :class="ROSTER_CLASS.title">listProviders()</span>
      <span :class="ROSTER_CLASS.meta">{{ rows.length }} {{ rows.length === 1 ? "provider" : "providers" }} · {{ order }}</span>
    </header>
    <div class="roster-ruler" aria-hidden="true" />
    <UTable v-model:sorting="sorting" :data="rows" :columns="columns" :get-row-id="(row) => row.key" :ui="ROSTER_TABLE_UI">
      <template #key-header="{ column }"><RosterSort :column="column" label="Provider" /></template>
      <template #title-header="{ column }"><RosterSort :column="column" label="Engine" /></template>
      <template #key-cell="{ row }">
        <NuxtLink :to="row.original.to" :class="[ROSTER_CLASS.name, 'max-w-full items-baseline']">
          <UIcon :name="row.original.icon" class="relative top-0.5 size-3.5 flex-none" aria-hidden="true" />
          <span class="truncate">{{ row.original.key }}</span>
          <span :class="[ROSTER_CLASS.id, 'flex-none']">#{{ row.original.place }}</span>
        </NuxtLink>
      </template>
      <template #title-cell="{ row }">
        <span class="whitespace-nowrap text-highlighted">{{ row.original.title }}</span>
      </template>
      <template #reference-cell="{ row }">
        <UTooltip :text="row.original.reference">
          <span class="block truncate text-muted" tabindex="0">{{ row.original.reference }}</span>
        </UTooltip>
      </template>
      <template #readOnly-cell="{ row }">
        <UTooltip :text="row.original.readOnly">
          <span :class="ROSTER_CLASS.count" tabindex="0"
            ><span :class="ROSTER_CLASS.leader" aria-hidden="true" /><span class="min-w-0 truncate text-highlighted"
              >enforced by the engine</span
            ></span
          >
        </UTooltip>
      </template>
    </UTable>
    <footer :class="ROSTER_CLASS.footer">
      <span>read from the registry</span>
      <span :class="ROSTER_CLASS.meta">writes off until DATABASES_WRITE=1</span>
    </footer>
  </section>
</template>
