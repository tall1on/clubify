<script setup lang="ts">
import { computed, type CSSProperties } from "vue";

const props = defineProps<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  display?: (value: number) => string;
}>();

const emit = defineEmits<{ change: [value: number] }>();

const formatted = computed(() =>
  props.display
    ? props.display(props.value)
    : `${props.value.toFixed(props.step < 1 ? 2 : 1)}${props.suffix ?? ""}`,
);

const fill = computed(() => {
  const percent = ((props.value - props.min) / (props.max - props.min)) * 100;
  return Math.min(100, Math.max(0, percent));
});

const inputStyle = computed<CSSProperties>(() => ({ "--fill": `${fill.value}%` }));

function onInput(event: Event) {
  emit("change", Number((event.target as HTMLInputElement).value));
}
</script>

<template>
  <label class="slider">
    <span class="slider-meta">
      <span>{{ label }}</span>
      <span class="slider-value">{{ formatted }}</span>
    </span>
    <input
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="value"
      :style="inputStyle"
      @input="onInput"
    />
  </label>
</template>
