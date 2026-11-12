<script setup lang="ts">
defineProps<{ title?: string }>();
</script>

<template>
  <DatabasesCallout kind="tip" :title="title"><slot mdc-unwrap="p" /></DatabasesCallout>
</template>
