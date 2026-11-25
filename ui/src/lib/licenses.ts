export type LicenseEcosystem = "npm" | "cargo" | "runtime";

export interface LicensePackage {
  name: string;
  version: string;
  ecosystem: LicenseEcosystem;
  license: string;
  homepage: string;
  note?: string;
  textIds: string[];
}

export interface ProjectLicense {
  name: string;
  version: string;
  license: string;
  copyright: string;
  text: string;
}

export interface LicenseData {
  generator: string;
  sources: string[];
  note: string;
  project: ProjectLicense;
  packages: LicensePackage[];
  texts: Record<string, string>;
}

export const ECOSYSTEM_LABELS: Record<LicenseEcosystem, string> = {
  npm: "Node.js production dependencies",
  cargo: "Rust dependencies (Windows target)",
  runtime: "Bundled runtime & native libraries",
};

let pending: Promise<LicenseData> | null = null;

export async function loadLicenses(): Promise<LicenseData> {
  pending ??= fetch(`${import.meta.env.BASE_URL}licenses.json`, { cache: "no-cache" })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`License data could not be loaded (HTTP ${response.status}).`);
      }
      return (await response.json()) as LicenseData;
    })
    .catch((error: unknown) => {
      pending = null;
      throw error;
    });
  return pending;
}
