<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import BrandMark from "./components/BrandMark.vue";
import LevelMeter from "./components/LevelMeter.vue";
import LicensesPanel from "./components/LicensesPanel.vue";
import RangeSlider from "./components/RangeSlider.vue";
import StatTile from "./components/StatTile.vue";
import { formatPids, formatUptime, phaseLabel } from "./lib/format";
import { useEngineStore } from "./stores/engine";

const engine = useEngineStore();
const { state, connection, socketError } = storeToRefs(engine);

const showGuide = ref(true);

const config = computed(() => state.value!.config);
const status = computed(() => state.value!.status);
const presets = computed(() => state.value!.presets);
const devices = computed(() => state.value!.devices);
const effects = computed(() => config.value.effects);
const preset = computed(() => presets.value.find((candidate) => candidate.id === config.value.presetId));
const accent = computed(() => preset.value?.accent ?? "#f43f8f");
const active = computed(() => status.value.phase === "running");

const formatPercent = (value: number) => `${Math.round(value * 100)}%`;
const formatRatio = (value: number) => `${value.toFixed(1)}:1`;

function toggleBypass() {
  engine.setBypass(effects.value.effectsEnabled);
}

function onOutputDeviceChange(event: Event) {
  engine.setOutputDevice((event.target as HTMLSelectElement).value || null);
}

function onAutoGainChange(event: Event) {
  engine.setAutoGain((event.target as HTMLInputElement).checked);
}

onMounted(() => engine.connect());
onBeforeUnmount(() => engine.disconnect());
</script>

<template>
  <main v-if="!state" class="shell">
    <div class="loading-card">
      <BrandMark />
      <h1>Clubify</h1>
      <p>
        {{
          connection === "closed"
            ? "Engine offline. Start it with `npm run engine`."
            : "Connecting to the audio engine..."
        }}
      </p>
      <p v-if="socketError" class="error-text">{{ socketError }}</p>
    </div>
    <LicensesPanel class="loading-licenses" />
  </main>

  <main v-else class="shell" :style="{ '--accent': accent }">
    <div class="aurora" aria-hidden="true"></div>
    <header class="topbar">
      <div class="brand">
        <BrandMark :pulse="active" />
        <div>
          <h1>Clubify</h1>
          <p>Spotify-only nightclub processing</p>
        </div>
      </div>
      <div class="status-pill" :class="status.phase">
        <span class="dot"></span>
        {{ phaseLabel(status.phase) }}
      </div>
    </header>

    <section class="hero card">
      <div class="hero-copy">
        <p class="eyebrow">NOW PLAYING</p>
        <h2>{{ preset?.name ?? "Custom chain" }}</h2>
        <p class="tagline">{{ preset?.tagline ?? "Your own late-night recipe" }}</p>
        <p class="message">{{ status.message ?? "Waiting for the engine" }}</p>
        <div class="hero-actions">
          <button
            class="power-button"
            :class="effects.effectsEnabled ? 'on' : 'off'"
            @click="toggleBypass"
          >
            <span class="power-icon" aria-hidden="true"></span>
            {{ effects.effectsEnabled ? "Club FX ON" : "Bypassed" }}
          </button>
          <button class="ghost-button" @click="engine.restart()">Reconnect Spotify</button>
        </div>
      </div>
      <div class="meter-panel">
        <LevelMeter label="Peak" :value="status.level.peakDb" :accent="accent" />
        <LevelMeter label="RMS" :value="status.level.rmsDb" :accent="accent" />
        <div class="meter-meta">
          <span>{{ status.bufferMs }} ms buffer</span>
          <span>{{ status.targetBufferMs }} ms target</span>
        </div>
      </div>
    </section>

    <section v-if="showGuide && !status.virtualCableDetected" class="guide card">
      <div>
        <p class="eyebrow">ROUTING CHECK</p>
        <h3>Send Spotify into a loopback cable</h3>
        <p>
          Clubify captures Spotify's process audio. To keep the original from playing twice,
          route Spotify to a virtual cable and Clubify will play the processed version on your
          normal headphones.
        </p>
        <ol>
          <li>Install VB-CABLE (or use an existing virtual audio cable).</li>
          <li>
            Windows 11: Settings → System → Sound → Volume mixer → Spotify → Output device →
            <strong> CABLE Input</strong>.
          </li>
          <li>Keep Clubify's output set to your headphones or speakers.</li>
        </ol>
        <p class="fine-print">
          No cable detected yet. You can still test the DSP, but Spotify will be audible twice
          until it is routed.
        </p>
      </div>
      <button class="ghost-button" @click="showGuide = false">Dismiss</button>
    </section>

    <section class="preset-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">ROOM PRESETS</p>
          <h3>Pick the room</h3>
        </div>
        <span class="fine-print">Instant recall</span>
      </div>
      <div class="preset-grid">
        <button
          v-for="candidate in presets"
          :key="candidate.id"
          class="preset-card"
          :class="{ selected: config.presetId === candidate.id }"
          :style="{ '--preset-accent': candidate.accent }"
          @click="engine.setPreset(candidate.id)"
        >
          <span class="preset-swatch"></span>
          <span class="preset-name">{{ candidate.name }}</span>
          <span class="preset-tagline">{{ candidate.tagline }}</span>
        </button>
      </div>
    </section>

    <section class="console-grid">
      <div class="card controls">
        <div class="section-heading">
          <div>
            <p class="eyebrow">THE DROP</p>
            <h3>Shape the sound</h3>
          </div>
          <span class="fine-print">Live, click-free</span>
        </div>
        <RangeSlider
          label="Bass"
          :value="effects.bassDb"
          :min="-12"
          :max="18"
          :step="0.5"
          suffix=" dB"
          @change="(value) => engine.setEffects({ bassDb: value })"
        />
        <RangeSlider
          label="Saturation"
          :value="effects.saturation"
          :min="0"
          :max="1"
          :step="0.01"
          :display="formatPercent"
          @change="(value) => engine.setEffects({ saturation: value })"
        />
        <RangeSlider
          label="Room level"
          :value="effects.reverbMix"
          :min="0"
          :max="1"
          :step="0.01"
          :display="formatPercent"
          @change="(value) => engine.setEffects({ reverbMix: value })"
        />
        <RangeSlider
          label="Room distance"
          :value="effects.distance"
          :min="0"
          :max="1"
          :step="0.01"
          :display="formatPercent"
          @change="(value) => engine.setEffects({ distance: value })"
        />
        <RangeSlider
          label="Compression"
          :value="effects.compression"
          :min="0"
          :max="1"
          :step="0.01"
          :display="formatPercent"
          @change="(value) => engine.setEffects({ compression: value })"
        />
        <RangeSlider
          label="Output"
          :value="effects.outputGainDb"
          :min="-18"
          :max="9"
          :step="0.5"
          suffix=" dB"
          @change="(value) => engine.setEffects({ outputGainDb: value })"
        />
      </div>

      <div class="card side-panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">ROUTING</p>
            <h3>Output</h3>
          </div>
        </div>
        <label class="field">
          <span>Playback device</span>
          <select :value="config.outputDeviceName ?? ''" @change="onOutputDeviceChange">
            <option value="">System default ({{ status.outputDeviceName ?? "pending" }})</option>
            <option
              v-for="device in devices"
              :key="`${device.id}-${device.name}`"
              :value="device.name"
            >
              {{ device.name }}
            </option>
          </select>
        </label>
        <RangeSlider
          label="Safety buffer"
          :value="config.targetBufferMs"
          :min="16"
          :max="240"
          :step="4"
          suffix=" ms"
          @change="(value) => engine.setBuffer(value)"
        />
        <label class="toggle-row">
          <span>
            <strong>Auto level</strong>
            <small>Match quiet captures to a club-ready level</small>
          </span>
          <input type="checkbox" :checked="config.autoGain" @change="onAutoGainChange" />
        </label>
        <div class="stats">
          <StatTile label="Spotify PID" :value="formatPids(status.spotifyPids)" />
          <StatTile label="Capture" :value="status.captureActive ? 'active' : 'idle'" />
          <StatTile
            label="Capture feed"
            :value="`${status.captureSampleRate / 1000} kHz ${status.captureFormat}`"
          />
          <StatTile label="Sample rate" :value="`${status.sampleRate / 1000} kHz`" />
          <StatTile
            label="Auto gain"
            :value="`${status.autoGainDb > 0 ? '+' : ''}${status.autoGainDb} dB`"
          />
          <StatTile label="Underruns" :value="String(status.underruns)" />
          <StatTile label="Overruns" :value="String(status.overruns)" />
          <StatTile label="Uptime" :value="formatUptime(status.uptimeSec)" />
        </div>
        <div class="cable-status" :class="status.virtualCableDetected ? 'ok' : 'warn'">
          <span class="dot"></span>
          {{
            status.virtualCableDetected
              ? "Virtual cable detected"
              : "No virtual audio cable detected"
          }}
        </div>
      </div>
    </section>

    <details class="card advanced">
      <summary>
        <span>
          <span class="eyebrow">FINE TUNING</span>
          <strong>Advanced sound design</strong>
        </span>
        <span class="chevron" aria-hidden="true"></span>
      </summary>
      <div class="advanced-grid">
        <RangeSlider
          label="Input trim"
          :value="effects.inputGainDb"
          :min="-24"
          :max="12"
          :step="0.5"
          suffix=" dB"
          @change="(value) => engine.setEffects({ inputGainDb: value })"
        />
        <RangeSlider
          label="Bass corner"
          :value="effects.bassFrequency"
          :min="40"
          :max="180"
          :step="1"
          suffix=" Hz"
          @change="(value) => engine.setEffects({ bassFrequency: value })"
        />
        <RangeSlider
          label="Low-mid scoop"
          :value="effects.lowMidCutDb"
          :min="-12"
          :max="0"
          :step="0.5"
          suffix=" dB"
          @change="(value) => engine.setEffects({ lowMidCutDb: value })"
        />
        <RangeSlider
          label="Scoop frequency"
          :value="effects.lowMidFrequency"
          :min="150"
          :max="800"
          :step="5"
          suffix=" Hz"
          @change="(value) => engine.setEffects({ lowMidFrequency: value })"
        />
        <RangeSlider
          label="PA presence"
          :value="effects.presenceDb"
          :min="0"
          :max="9"
          :step="0.5"
          suffix=" dB"
          @change="(value) => engine.setEffects({ presenceDb: value })"
        />
        <RangeSlider
          label="Presence frequency"
          :value="effects.presenceFrequency"
          :min="800"
          :max="5000"
          :step="50"
          suffix=" Hz"
          @change="(value) => engine.setEffects({ presenceFrequency: value })"
        />
        <RangeSlider
          label="Air damping"
          :value="effects.airDampingHz"
          :min="4000"
          :max="20000"
          :step="250"
          suffix=" Hz"
          @change="(value) => engine.setEffects({ airDampingHz: value })"
        />
        <RangeSlider
          label="Stereo width"
          :value="effects.width"
          :min="0"
          :max="1"
          :step="0.01"
          :display="formatPercent"
          @change="(value) => engine.setEffects({ width: value })"
        />
        <RangeSlider
          label="Early reflections"
          :value="effects.earlyReflections"
          :min="0"
          :max="1"
          :step="0.01"
          :display="formatPercent"
          @change="(value) => engine.setEffects({ earlyReflections: value })"
        />
        <RangeSlider
          label="Reverb predelay"
          :value="effects.reverbPredelayMs"
          :min="0"
          :max="60"
          :step="1"
          suffix=" ms"
          @change="(value) => engine.setEffects({ reverbPredelayMs: value })"
        />
        <RangeSlider
          label="Reverb ducking"
          :value="effects.reverbDuck"
          :min="0"
          :max="1"
          :step="0.01"
          :display="formatPercent"
          @change="(value) => engine.setEffects({ reverbDuck: value })"
        />
        <RangeSlider
          label="Reverb size"
          :value="effects.reverbSize"
          :min="0.2"
          :max="0.95"
          :step="0.01"
          :display="formatPercent"
          @change="(value) => engine.setEffects({ reverbSize: value })"
        />
        <RangeSlider
          label="Reverb damping"
          :value="effects.reverbDamping"
          :min="0"
          :max="1"
          :step="0.01"
          :display="formatPercent"
          @change="(value) => engine.setEffects({ reverbDamping: value })"
        />
        <RangeSlider
          label="Compressor threshold"
          :value="effects.thresholdDb"
          :min="-48"
          :max="0"
          :step="0.5"
          suffix=" dB"
          @change="(value) => engine.setEffects({ thresholdDb: value })"
        />
        <RangeSlider
          label="Compressor ratio"
          :value="effects.ratio"
          :min="1"
          :max="20"
          :step="0.5"
          :display="formatRatio"
          @change="(value) => engine.setEffects({ ratio: value })"
        />
      </div>
    </details>

    <LicensesPanel />

    <footer>
      <span>Spotify</span>
      <span class="arrow">→</span>
      <span>Process loopback</span>
      <span class="arrow">→</span>
      <span>Club DSP</span>
      <span class="arrow">→</span>
      <span>WASAPI out</span>
      <span class="license-note">GPLv3 licensed · © 2026 Luke Grandke</span>
      <span class="connection" :class="connection">
        {{ connection === "open" ? "LIVE" : connection.toUpperCase() }}
      </span>
    </footer>
  </main>
</template>
