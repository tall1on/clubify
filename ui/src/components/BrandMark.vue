<script setup lang="ts">
defineProps<{ pulse?: boolean }>();
</script>

<template>
  <div class="brand-mark" :class="{ pulse }" aria-hidden="true">
    <span></span>
    <span></span>
    <span></span>
    <span></span>
  </div>
</template>
