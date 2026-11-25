<script setup lang="ts">
import { computed, ref } from "vue";
import {
  ECOSYSTEM_LABELS,
  type LicenseData,
  type LicensePackage,
  loadLicenses,
} from "../lib/licenses";

const data = ref<LicenseData | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);
const query = ref("");
const openEntries = ref(new Set<string>());

async function ensureLoaded() {
  if (data.value || loading.value) return;
  loading.value = true;
  loadError.value = null;
  try {
    data.value = await loadLicenses();
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "Could not load the license page.";
  } finally {
    loading.value = false;
  }
}

function onToggle(event: Event) {
  if ((event.currentTarget as HTMLDetailsElement).open) void ensureLoaded();
}

const packages = computed(() => data.value?.packages ?? []);
const project = computed(() => data.value?.project ?? null);

const PROJECT_LICENSE_LABELS: Record<string, string> = {
  "GPL-3.0-only": "GPLv3",
  "GPL-3.0-or-later": "GPLv3 or later",
};

const projectLicenseLabel = computed(() => {
  const license = project.value?.license;
  if (!license) return "";
  return PROJECT_LICENSE_LABELS[license] ?? license;
});

const filteredPackages = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return packages.value;
  return packages.value.filter((entry) =>
    [entry.name, entry.version, entry.license, ECOSYSTEM_LABELS[entry.ecosystem]].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
});

const groups = computed(() => {
  const grouped = new Map<string, LicensePackage[]>();
  for (const entry of filteredPackages.value) {
    const label = ECOSYSTEM_LABELS[entry.ecosystem] ?? "Other";
    const bucket = grouped.get(label);
    if (bucket) bucket.push(entry);
    else grouped.set(label, [entry]);
  }
  return [...grouped.entries()].map(([label, entries]) => ({ label, entries }));
});

function textsFor(entry: LicensePackage): string[] {
  if (!data.value) return [];
  return entry.textIds
    .map((id) => data.value?.texts[id])
    .filter((text): text is string => Boolean(text));
}

function entryKey(entry: LicensePackage): string {
  return `${entry.ecosystem}:${entry.name}@${entry.version}`;
}

function onEntryToggle(entry: LicensePackage, event: Event) {
  const key = entryKey(entry);
  const next = new Set(openEntries.value);
  if ((event.currentTarget as HTMLDetailsElement).open) next.add(key);
  else next.delete(key);
  openEntries.value = next;
}
</script>

<template>
  <details id="licenses" class="card licenses" @toggle="onToggle">
    <summary>
      <span>
        <span class="eyebrow">LEGAL</span>
        <strong>Licenses &amp; third-party notices</strong>
      </span>
      <span class="chevron" aria-hidden="true"></span>
    </summary>
    <div class="licenses-body">
      <section class="license-block">
        <div class="section-heading">
          <div>
            <p class="eyebrow">PROJECT LICENSE</p>
            <h3 v-if="project">{{ project.name }} is {{ projectLicenseLabel }} licensed</h3>
            <h3 v-else>Project license</h3>
          </div>
          <span class="fine-print">{{ project?.copyright ?? "See LICENSE" }}</span>
        </div>
        <template v-if="project">
          <p class="license-intro">
            Clubify is free software distributed under the {{ projectLicenseLabel }} license.
            It comes with no warranty, to the extent permitted by law. The full text below
            governs use, copying, modification, and distribution of the project.
          </p>
          <pre class="license-text">{{ project.text }}</pre>
          <p v-if="project.homepage" class="license-source">Source: {{ project.homepage }}</p>
        </template>
        <p v-else-if="loadError" class="error-text">{{ loadError }}</p>
        <p v-else class="fine-print">
          {{ loading ? "Loading license data..." : "Open this section to load the license data." }}
        </p>
      </section>

      <section class="license-block">
        <div class="section-heading">
          <div>
            <p class="eyebrow">THIRD-PARTY COMPONENTS</p>
            <h3>Dependency licenses</h3>
          </div>
          <span class="fine-print">
            {{ packages.length > 0 ? `${packages.length} components` : "Generated at build" }}
          </span>
        </div>
        <p class="license-intro">
          This list is generated from the installed npm production dependency tree and the Rust
          dependency graph for the Windows target. Expand a component to read its full license,
          copyright notice, and upstream source.
        </p>

        <label v-if="packages.length > 0" class="license-search">
          <span class="visually-hidden">Filter bundled software</span>
          <input
            v-model="query"
            type="search"
            placeholder="Filter by package, version, or license..."
          />
        </label>

        <p v-if="loadError" class="error-text">{{ loadError }}</p>
        <p v-else-if="loading" class="fine-print">Loading license data...</p>
        <p v-else-if="packages.length === 0" class="fine-print">
          Open this section to load third-party notices.
        </p>
        <p v-else-if="filteredPackages.length === 0" class="fine-print">
          No components match "{{ query }}".
        </p>

        <div v-for="group in groups" :key="group.label" class="license-group">
          <p class="license-group-title">{{ group.label }} ({{ group.entries.length }})</p>
          <ul class="license-list">
            <li
              v-for="entry in group.entries"
              :key="`${entry.ecosystem}-${entry.name}-${entry.version}`"
            >
              <details class="license-entry" @toggle="onEntryToggle(entry, $event)">
                <summary>
                  <span class="license-name">
                    {{ entry.name }}
                    <span v-if="entry.version" class="license-version">{{ entry.version }}</span>
                  </span>
                  <span class="license-tag">{{ entry.license }}</span>
                  <span class="entry-chevron" aria-hidden="true"></span>
                </summary>
                <div v-if="openEntries.has(entryKey(entry))" class="license-entry-body">
                  <p v-if="entry.note" class="fine-print">{{ entry.note }}</p>
                  <pre
                    v-for="(text, index) in textsFor(entry)"
                    :key="index"
                    class="license-text"
                  >{{ text }}</pre>
                  <p v-if="entry.homepage" class="license-source">Source: {{ entry.homepage }}</p>
                </div>
              </details>
            </li>
          </ul>
        </div>

        <p v-if="packages.length > 0" class="fine-print license-footnote">
          Generated from LICENSE, package-lock.json, and Cargo.lock by
          scripts/generate-licenses.mjs. Run `npm run licenses:generate` after changing npm or
          Cargo dependencies.
        </p>
      </section>
    </div>
  </details>
</template>
