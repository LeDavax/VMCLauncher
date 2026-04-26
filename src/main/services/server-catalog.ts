import type { ServerCatalogEntry, ServerCatalogVersionEntry, ServerKind } from "../../shared/contracts";
import type { OpenVmcAuthClient, VmcCompatibilityEntry } from "./auth-client";
import { OPENVMC_USER_AGENT } from "./downloads";

const CATALOG_CACHE_MS = 5 * 60 * 1000;
const PRE_RELEASE_RE = /(alpha|beta|pre|preview|rc|snapshot)/i;
const FORGE_FULL_VERSION_RE = /^((?:1\.\d+(?:\.\d+)?|\d+\.\d+(?:\.\d+)?))-(\d+(?:\.\d+)+)$/;
const NEOFORGE_FULL_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

type ProviderVersions = Record<string, string>;

interface CatalogCache {
  expiresAt: number;
  entries: ServerCatalogEntry[];
}

export class ServerCatalogService {
  private cache: CatalogCache | null = null;

  constructor(private readonly authClient: OpenVmcAuthClient) {}

  async getCatalog(): Promise<ServerCatalogEntry[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.entries;
    }

    const [vanilla, papermc, purpur, fabric, forge, neoforge, vmcCompat] = await Promise.all([
      this.safeFetchProvider(fetchVanillaVersions),
      this.safeFetchProvider(fetchPaperVersions),
      this.safeFetchProvider(fetchPurpurVersions),
      this.safeFetchProvider(fetchFabricVersions),
      this.safeFetchProvider(fetchForgeVersions),
      this.safeFetchProvider(fetchNeoForgeVersions),
      this.safeFetchVmcCompatibility(),
    ]);

    const vmcIndex = new Map<string, string>();
    for (const entry of vmcCompat) {
      vmcIndex.set(`${entry.kind}:${entry.version}`, entry.patchUrl);
    }

    const entries: ServerCatalogEntry[] = [
      buildCatalogEntry("vanilla", "Minecraft Vanilla", vanilla, vmcIndex),
      buildCatalogEntry("papermc", "PaperMC", papermc, vmcIndex),
      buildCatalogEntry("purpur", "Purpur", purpur, vmcIndex),
      buildCatalogEntry("fabric", "Fabric", fabric, vmcIndex),
      buildCatalogEntry("forge", "Forge", forge, vmcIndex),
      buildCatalogEntry("neoforge", "NeoForge", neoforge, vmcIndex),
    ];

    this.cache = {
      expiresAt: now + CATALOG_CACHE_MS,
      entries,
    };
    return entries;
  }

  async findVersion(kind: ServerKind, version: string): Promise<ServerCatalogVersionEntry | null> {
    const catalog = await this.getCatalog();
    const entry = catalog.find((item) => item.kind === kind);
    if (!entry) {
      return null;
    }
    return entry.versions.find((item) => item.version === version) ?? null;
  }

  private async safeFetchProvider(fetcher: () => Promise<ProviderVersions>): Promise<ProviderVersions> {
    try {
      return await fetcher();
    } catch {
      return {};
    }
  }

  private async safeFetchVmcCompatibility(): Promise<VmcCompatibilityEntry[]> {
    try {
      return await this.authClient.getVmcCompatibilityCatalog();
    } catch {
      return [];
    }
  }
}

function buildCatalogEntry(
  kind: ServerKind,
  label: string,
  versions: ProviderVersions,
  vmcIndex: Map<string, string>,
): ServerCatalogEntry {
  const versionEntries = Object.entries(versions)
    .sort(([left], [right]) => compareVersionLike(right, left))
    .map(([version, downloadUrl]) => {
      const patchUrl = vmcIndex.get(`${kind}:${version}`) ?? null;
      return {
        version,
        downloadUrl,
        vmc: {
          compatible: Boolean(patchUrl),
          patchUrl,
        },
      } satisfies ServerCatalogVersionEntry;
    });

  return {
    kind,
    label,
    subtitle: "Versions chargees dynamiquement",
    versions: versionEntries,
  };
}

async function fetchVanillaVersions(): Promise<ProviderVersions> {
  const manifest = await fetchJson<{
    versions: Array<{ id: string; type: string; url: string }>;
  }>("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
  const releases = manifest.versions.filter((item) => item.type === "release");
  const results: ProviderVersions = {};

  await runWithLimit(releases, 8, async (release) => {
    const details = await fetchJson<{ downloads?: { server?: { url?: string } } }>(release.url);
    const url = details.downloads?.server?.url;
    if (url) {
      results[release.id] = url;
    }
  });

  return results;
}

async function fetchPaperVersions(): Promise<ProviderVersions> {
  const project = await fetchJson<{ versions: Record<string, string[]> }>("https://fill.papermc.io/v3/projects/paper");
  const allVersions = [...new Set(Object.values(project.versions ?? {}).flat())].filter(
    (version) => !PRE_RELEASE_RE.test(version),
  );
  const results: ProviderVersions = {};

  await runWithLimit(allVersions, 8, async (version) => {
    const builds = await fetchJson<Array<{
      channel: string;
      downloads: Record<string, { url: string }>;
    }>>(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`);
    const stable = builds.find((build) => build.channel === "STABLE" && build.downloads["server:default"]?.url);
    if (stable) {
      results[version] = stable.downloads["server:default"].url;
    }
  });
  return results;
}

async function fetchPurpurVersions(): Promise<ProviderVersions> {
  const payload = await fetchJson<{ versions: string[] }>("https://api.purpurmc.org/v2/purpur");
  const results: ProviderVersions = {};
  for (const version of payload.versions ?? []) {
    if (!PRE_RELEASE_RE.test(version)) {
      results[version] = `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/latest/download`;
    }
  }
  return results;
}

async function fetchFabricVersions(): Promise<ProviderVersions> {
  const [gameVersions, loaderVersions, installerVersions] = await Promise.all([
    fetchJson<Array<{ version: string; stable: boolean }>>("https://meta.fabricmc.net/v2/versions/game"),
    fetchJson<Array<{ version: string; stable: boolean }>>("https://meta.fabricmc.net/v2/versions/loader"),
    fetchJson<Array<{ version: string; stable: boolean }>>("https://meta.fabricmc.net/v2/versions/installer"),
  ]);
  const loader = loaderVersions.find((entry) => entry.stable)?.version;
  const installer = installerVersions.find((entry) => entry.stable)?.version;
  if (!loader || !installer) {
    return {};
  }

  const results: ProviderVersions = {};
  for (const entry of gameVersions) {
    if (entry.stable && !PRE_RELEASE_RE.test(entry.version)) {
      results[entry.version] = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(entry.version)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`;
    }
  }
  return results;
}

async function fetchForgeVersions(): Promise<ProviderVersions> {
  const xml = await fetchText("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml");
  const latestByMinecraft = new Map<string, { forgeVersion: string; url: string }>();
  for (const fullVersion of extractMavenVersions(xml)) {
    if (PRE_RELEASE_RE.test(fullVersion)) continue;
    const match = fullVersion.match(FORGE_FULL_VERSION_RE);
    if (!match) continue;
    const mcVersion = match[1];
    const forgeVersion = match[2];
    const current = latestByMinecraft.get(mcVersion);
    if (!current || compareVersionLike(forgeVersion, current.forgeVersion) > 0) {
      latestByMinecraft.set(mcVersion, {
        forgeVersion,
        url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-installer.jar`,
      });
    }
  }
  return Object.fromEntries([...latestByMinecraft.entries()].map(([mc, data]) => [mc, data.url]));
}

async function fetchNeoForgeVersions(): Promise<ProviderVersions> {
  const xml = await fetchText("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml");
  const latestByMinecraft = new Map<string, { fullVersion: string; url: string }>();
  for (const fullVersion of extractMavenVersions(xml)) {
    if (PRE_RELEASE_RE.test(fullVersion)) continue;
    const match = fullVersion.match(NEOFORGE_FULL_VERSION_RE);
    if (!match) continue;
    const mcVersion = mapNeoForgeMinecraftVersion(match[1], match[2]);
    const current = latestByMinecraft.get(mcVersion);
    if (!current || compareVersionLike(fullVersion, current.fullVersion) > 0) {
      latestByMinecraft.set(mcVersion, {
        fullVersion,
        url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${fullVersion}/neoforge-${fullVersion}-installer.jar`,
      });
    }
  }
  return Object.fromEntries([...latestByMinecraft.entries()].map(([mc, data]) => [mc, data.url]));
}

function mapNeoForgeMinecraftVersion(major: string, minor: string): string {
  const majorNumber = Number(major);
  if (Number.isFinite(majorNumber) && majorNumber >= 26) {
    return `${major}.${minor}`;
  }
  return `1.${major}.${minor}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": OPENVMC_USER_AGENT,
      Accept: "application/json",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json() as Promise<T>;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": OPENVMC_USER_AGENT,
      Accept: "application/xml, text/xml;q=0.9, */*;q=0.8",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

function extractMavenVersions(xml: string): string[] {
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]);
}

async function runWithLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, Math.max(1, queue.length)) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) {
        return;
      }
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function compareVersionLike(a: string, b: string): number {
  const normalize = (value: string) =>
    value.split(/[^0-9A-Za-z]+/).filter(Boolean).map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
  const aParts = normalize(a);
  const bParts = normalize(b);
  const max = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < max; index += 1) {
    const left = aParts[index];
    const right = bParts[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (typeof left === "number" && typeof right === "number") {
      if (left !== right) return left - right;
    } else {
      const cmp = String(left).localeCompare(String(right));
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}
