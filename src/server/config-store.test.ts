import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clampParams, defaultEffects } from "../shared/presets.js";
import type { Preset } from "../shared/types.js";
import {
  customPresetsPath,
  loadConfig,
  loadCustomPresets,
  saveConfig,
  saveCustomPresets,
} from "./config-store.js";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "clubify-test-"));
  process.env.CLUBIFY_CONFIG_DIR = directory;
});

afterEach(() => {
  delete process.env.CLUBIFY_CONFIG_DIR;
  rmSync(directory, { recursive: true, force: true });
});

function customPreset(id: string, name: string, patch: { bassDb?: number; reverbMix?: number }): Preset {
  return {
    id,
    name,
    tagline: "Manual preset",
    accent: "#38bdf8",
    params: clampParams({ ...defaultEffects(), ...patch }),
    custom: true,
  };
}

describe("custom presets", () => {
  it("persists and reloads manually saved presets", () => {
    saveCustomPresets([customPreset("custom-test", "Test room", { bassDb: 12 })]);

    const loaded = loadCustomPresets();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: "custom-test", name: "Test room", custom: true });
    expect(loaded[0]!.params.bassDb).toBe(12);
  });

  it("resolves a custom preset when loading the config", () => {
    const preset = customPreset("custom-room", "Room", { bassDb: 9, reverbMix: 0.2 });
    saveCustomPresets([preset]);
    saveConfig({
      presetId: preset.id,
      effects: preset.params,
      spotifyImageName: "Spotify.exe",
      outputDeviceName: null,
      targetBufferMs: 48,
      autoGain: true,
    });

    const config = loadConfig();
    expect(config.presetId).toBe("custom-room");
    expect(config.effects.bassDb).toBe(9);
    expect(config.effects.reverbMix).toBe(0.2);
  });

  it("ignores malformed preset files", () => {
    writeFileSync(customPresetsPath(), "{not json", "utf8");
    expect(loadCustomPresets()).toEqual([]);
  });

  it("drops entries without a custom id or name", () => {
    writeFileSync(
      customPresetsPath(),
      JSON.stringify([
        { id: "afterhours", name: "Built-in lookalike", params: {} },
        { id: "custom-ok", name: "", params: {} },
        { id: "custom-valid", name: "Valid", params: { bassDb: 3 } },
      ]),
      "utf8",
    );

    const loaded = loadCustomPresets();
    expect(loaded.map((preset) => preset.id)).toEqual(["custom-valid"]);
  });
});
