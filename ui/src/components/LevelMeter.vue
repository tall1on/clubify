<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  label: string;
  value: number;
  accent: string;
}>();

const percent = computed(() => Math.min(100, Math.max(0, ((props.value + 60) / 60) * 100)));
const background = computed(() => `linear-gradient(90deg, ${props.accent}, #ffffff)`);
</script>

<template>
  <div class="level">
    <div class="level-meta">
      <span>{{ label }}</span>
      <span>{{ value <= -89 ? "-∞" : `${value.toFixed(1)} dB` }}</span>
    </div>
    <div class="level-track">
      <div class="level-fill" :style="{ width: `${percent}%`, background }"></div>
    </div>
  </div>
</template>
