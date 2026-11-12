<script setup lang="ts">
defineProps<{ title?: string }>();
</script>

<template>
  <DatabasesCallout kind="note" :title="title"><slot mdc-unwrap="p" /></DatabasesCallout>
</template>
