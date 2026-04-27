import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, stat, writeFile, rm, rename, cp } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type {
  ConsoleLine,
  CreateServerPayload,
  LauncherEvent,
  PluginInstallRequest,
  PluginInstallResult,
  PluginProvider,
  PluginSearchResult,
  ServerDetails,
  ServerFileContent,
  ServerRecord,
  ServerStats,
  UpdateServerSettingsPayload,
  UpdateVmcSettingsPayload,
} from "../../shared/contracts";
import { DEFAULT_SERVER_SETTINGS } from "../../shared/contracts";
import { OpenVmcAuthClient } from "./auth-client";
import { JavaRuntimeManager } from "./java-runtime";
import { ServerCatalogService } from "./server-catalog";
import { downloadFile, resolveVelocityArtifact } from "./downloads";
import {
  PluginMarketplaceService,
  getPaperPluginsDirectory,
} from "./plugin-marketplaces";
import {
  getAddonsDirectory,
  getRuntimeDirectory,
} from "./server-layout";
import {
  LauncherStateStore,
  type PersistedServerRecord,
  slugify,
} from "./storage";

interface RuntimeProcess {
  name: "paper" | "velocity";
  child: ChildProcessWithoutNullStreams;
}

interface RuntimeState {
  startedAt: number | null;
  isStopping: boolean;
  consoleLines: ConsoleLine[];
  processes: Partial<Record<"paper" | "velocity", RuntimeProcess>>;
  stats: ServerStats;
  statsTimer: NodeJS.Timeout | null;
  lastStorageCheck?: number;
}

const MAX_CONSOLE_LINES = 500;
const STATS_REFRESH_INTERVAL_MS = 1_000;
const MAX_EDITABLE_FILE_BYTES = 1024 * 1024;
const execFileAsync = promisify(execFile);

export class ServerManager {
  private readonly runtimes = new Map<string, RuntimeState>();
  private readonly consoleHistory = new Map<string, ConsoleLine[]>();
  private activeServerId: string | null = null;
  private readonly pluginMarketplace: PluginMarketplaceService;

  constructor(
    private readonly stateStore: LauncherStateStore,
    private readonly authClient: OpenVmcAuthClient,
    private readonly catalogService: ServerCatalogService,
    private readonly javaManager: JavaRuntimeManager,
    private readonly cacheDir: string,
    private readonly emitEvent: (event: LauncherEvent) => void,
  ) {
    this.pluginMarketplace = new PluginMarketplaceService(
      cacheDir,
      () => process.env.VMC_CURSEFORGE_API_KEY?.trim() || null,
    );
  }

  async start() {
    void this.cleanupZombieProcesses();
  }

  getActiveServerId(): string | null {
    return this.activeServerId;
  }

  async createServer(payload: CreateServerPayload): Promise<ServerRecord> {
    const owner = this.stateStore.requireCurrentAccount();
    const now = new Date().toISOString();
    const serverUuid = randomUUID();
    const slug = slugify(payload.displayName);
    const portBlock = this.stateStore.getNextPortBlock();
    const token = this.stateStore.getAuthToken();
    if (!token) {
      throw new Error("Session OpenVMC indisponible.");
    }
    const catalogVersion = await this.catalogService.findVersion(payload.kind, payload.version);
    if (!catalogVersion) {
      throw new Error(
        `La version ${payload.version} n'est pas presente dans le catalogue pour ${payload.kind}.`,
      );
    }
    const vmcEnabled = Boolean(payload.vmcEnabled && catalogVersion.vmc.compatible);
    const rootDir = path.join(this.stateStore.getPaths().serversDir, `${slug}-${serverUuid}`);
    const remoteServer = await this.authClient.createRemoteServer(
      token,
      this.stateStore.getDeviceId(),
      payload,
      serverUuid,
    );
    const paperPort = await this.findAvailablePort(25565);
    const velocityPort = vmcEnabled ? await this.findAvailablePort(paperPort + 1) : null;

    const server: PersistedServerRecord = {
      serverUuid,
      ownerAccountId: owner.id,
      remoteServerId: remoteServer.id,
      displayName: payload.displayName.trim(),
      slug,
      kind: payload.kind,
      version: payload.version,
      memoryMb: payload.memoryMb,
      status: "stopped",
      createdAt: now,
      updatedAt: now,
      lastPlayedAt: null,
      rootDir,
      paperPort,
      velocityPort,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        motd: payload.displayName.trim(),
      },
      vmc: {
        enabled: vmcEnabled,
        slug,
        mode: payload.vmcMode ?? "whitelist",
        whitelist: [owner.displayName],
        lastAccessCode: null,
        lastAccessCodeIssuedAt: null,
        state: vmcEnabled ? "connected" : "disabled",
      },
    };

    await this.ensureServerLayout(server);
    await this.writeServerConfiguration(server);
    if (server.vmc.enabled) await this.writeVelocityConfiguration(server);

    await this.stateStore.addServer(server);
    return server;
  }

  async deleteServer(serverUuid: string): Promise<void> {
    const server = this.stateStore.findServer(serverUuid);
    if (!server) return;
    
    if (this.runtimes.has(serverUuid)) {
      throw new Error("Impossible de supprimer un serveur en cours d'exécution.");
    }

    const token = this.stateStore.getAuthToken();
    if (token && server.remoteServerId) {
      try {
        await this.authClient.deleteRemoteServer(token, this.stateStore.getDeviceId(), server.remoteServerId);
      } catch (err) {
        console.warn(`Echec de la suppression distante du serveur ${serverUuid}:`, err);
        // On continue quand même la suppression locale
      }
    }
    
    await this.stateStore.deleteServer(serverUuid);
    this.consoleHistory.delete(serverUuid);
    await rm(server.rootDir, { recursive: true, force: true }).catch(() => {});
    this.emitEvent({ type: "state-changed" });
  }

  async renameServer(serverUuid: string, newName: string): Promise<ServerRecord> {
    const updated = await this.stateStore.updateServer(serverUuid, (server) => {
      server.displayName = newName;
      return server;
    });

    const token = this.stateStore.getAuthToken();
    const server = this.stateStore.findServer(serverUuid);
    if (token && server?.remoteServerId) {
      await this.authClient.renameRemoteServer(token, this.stateStore.getDeviceId(), server.remoteServerId, newName).catch((err) => {
        console.warn(`Echec du renommage distant du serveur ${serverUuid}:`, err);
      });
    }

    this.emitEvent({ type: "server-updated", serverUuid });
    return updated;
  }

  async getServerDetails(serverUuid: string): Promise<ServerDetails> {
    const server = this.requireServer(serverUuid);
    const runtime = this.runtimes.get(serverUuid);
    const stats = {
      ...(runtime?.stats ?? buildInitialStats(server)),
      uptimeSeconds: runtime?.startedAt ? Math.max(0, Math.floor((Date.now() - runtime.startedAt) / 1000)) : 0,
    };

    return {
      server,
      stats,
      consoleLines: runtime?.consoleLines ?? this.consoleHistory.get(serverUuid) ?? [],
      files: await readManagedFiles(server.rootDir),
      plugins: await this.pluginMarketplace.listInstalledPlugins(server),
    };
  }

  async startServer(serverUuid: string): Promise<void> {
    const server = this.requireServer(serverUuid);
    if (this.runtimes.has(serverUuid)) {
      return;
    }

    await this.patchServer(serverUuid, (current) => ({
      ...current,
      status: "starting",
      updatedAt: new Date().toISOString(),
    }));

    const runtime: RuntimeState = {
      startedAt: Date.now(),
      isStopping: false,
      consoleLines: [...(this.consoleHistory.get(serverUuid) ?? [])],
      processes: {},
      stats: buildInitialStats(server),
      statsTimer: null,
    };
    this.runtimes.set(serverUuid, runtime);
    this.activeServerId = serverUuid;
    this.emitEvent({ type: "state-changed", serverUuid });

    try {
      const javaExecutable = await this.javaManager.ensureJavaExecutable();
      
      const isPortAvailable = await checkPortAvailability(server.paperPort);
      if (!isPortAvailable) {
        throw new Error(`Le port ${server.paperPort} est déjà utilisé par une autre application. Veuillez fermer l'application qui l'utilise ou changer le port dans les réglages.`);
      }

      await this.prepareServerFiles(server, javaExecutable);

      const runtimeDir = getRuntimeDirectory(server.rootDir, server.kind);
      const launch = await this.resolveServerLaunch(server, runtimeDir);
      runtime.processes.paper = this.spawnProcess(
        server,
        runtime,
        "paper",
        javaExecutable,
        launch.args,
        launch.cwd,
      );

      if (server.vmc.enabled) {
        const velocityJar = path.join(server.rootDir, "velocity", "velocity.jar");
        runtime.processes.velocity = this.spawnProcess(
          server,
          runtime,
          "velocity",
          javaExecutable,
          ["-Xms512M", "-Xmx512M", "-jar", velocityJar],
          path.join(server.rootDir, "velocity"),
        );
      }

      this.startStatsPolling(server, runtime);

      await this.patchServer(serverUuid, (current) => ({
        ...current,
        status: "running",
        updatedAt: new Date().toISOString(),
        lastPlayedAt: new Date().toISOString(),
      }));
      this.appendConsoleLine(runtime, "info", `OpenVMC: serveur ${server.displayName} demarre.`);
    } catch (error) {
      this.appendConsoleLine(runtime, "error", `OpenVMC: ${(error as Error).message}`);
      this.consoleHistory.set(serverUuid, [...runtime.consoleLines]);
      this.runtimes.delete(serverUuid);
      this.activeServerId = null;
      await this.patchServer(serverUuid, (current) => ({
        ...current,
        status: "error",
        updatedAt: new Date().toISOString(),
      }));
      throw error;
    } finally {
      this.emitEvent({ type: "server-updated", serverUuid });
    }
  }

  async stopServer(serverUuid: string): Promise<void> {
    const runtime = this.runtimes.get(serverUuid);
    if (!runtime) {
      await this.patchServer(serverUuid, (current) => ({
        ...current,
        status: "stopped",
        updatedAt: new Date().toISOString(),
      }));
      return;
    }

    runtime.isStopping = true;
    await this.patchServer(serverUuid, (current) => ({
      ...current,
      status: "stopping",
      updatedAt: new Date().toISOString(),
    }));

    const processes = Object.values(runtime.processes).filter(Boolean) as RuntimeProcess[];
    for (const process of processes) {
      if (process.name === "velocity") {
        process.child.stdin.write("shutdown\n");
      } else {
        process.child.stdin.write("stop\n");
      }
    }

    await Promise.all(processes.map((process) => waitForProcessExit(process.child, 10_000)));
    this.stopStatsPolling(runtime);
    this.consoleHistory.set(serverUuid, [...runtime.consoleLines]);
    this.runtimes.delete(serverUuid);
    if (this.activeServerId === serverUuid) {
      this.activeServerId = null;
    }

    await this.patchServer(serverUuid, (current) => ({
      ...current,
      status: "stopped",
      updatedAt: new Date().toISOString(),
    }));
    this.emitEvent({ type: "state-changed", serverUuid });
  }

  async sendConsoleCommand(serverUuid: string, command: string): Promise<void> {
    const runtime = this.runtimes.get(serverUuid);
    if (!runtime) {
      throw new Error("Le serveur n'est pas demarre.");
    }

    const trimmed = command.trim();
    if (!trimmed) {
      return;
    }

    const target = trimmed.startsWith("proxy:") ? runtime.processes.velocity : runtime.processes.paper;
    if (!target) {
      throw new Error("Console cible indisponible.");
    }

    const actualCommand = trimmed.startsWith("proxy:") ? trimmed.slice("proxy:".length).trim() : trimmed;
    target.child.stdin.write(`${actualCommand}\n`);
    this.appendConsoleLine(runtime, "command", `> ${trimmed}`);
    this.emitEvent({ type: "server-updated", serverUuid });
  }

  async readServerFile(serverUuid: string, relativePath: string): Promise<ServerFileContent> {
    const server = this.requireServer(serverUuid);
    const absolutePath = await this.resolveEditableFilePath(server, relativePath);
    const buffer = await readFile(absolutePath);
    if (buffer.length > MAX_EDITABLE_FILE_BYTES) {
      throw new Error("Le fichier est trop volumineux pour l'editeur integre (max 1 MiB).");
    }
    if (buffer.includes(0)) {
      throw new Error("Les fichiers binaires ne sont pas pris en charge par l'editeur.");
    }

    const fileStat = await stat(absolutePath);
    return {
      path: path.relative(server.rootDir, absolutePath),
      content: buffer.toString("utf8"),
      modifiedAt: fileStat.mtime.toISOString(),
    };
  }

  async writeServerFile(serverUuid: string, relativePath: string, content: string) {
    const server = this.requireServer(serverUuid);
    const absolutePath = await this.resolveWritableFilePath(server, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
    const fileStat = await stat(absolutePath);
    this.emitEvent({ type: "server-updated", serverUuid });
    return {
      name: path.basename(absolutePath),
      path: path.relative(server.rootDir, absolutePath),
      kind: "file" as const,
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
    };
  }

  async searchPlugins(
    serverUuid: string,
    provider: PluginProvider,
    query: string,
  ): Promise<PluginSearchResult[]> {
    const server = this.requireServer(serverUuid);
    return this.pluginMarketplace.search(server, provider, query.trim());
  }

  async installPlugin(payload: PluginInstallRequest): Promise<PluginInstallResult> {
    const server = this.requireServer(payload.serverUuid);
    const result = await this.pluginMarketplace.install(server, payload);
    this.emitEvent({ type: "server-updated", serverUuid: payload.serverUuid });
    return result;
  }

  async updateServerSettings(payload: UpdateServerSettingsPayload): Promise<ServerRecord> {
    const updated = await this.patchServer(payload.serverUuid, (server) => ({
      ...server,
      settings: { ...server.settings, ...payload.settings },
      updatedAt: new Date().toISOString(),
    }));
      await this.writeServerConfiguration(updated);
    return updated;
  }

  async updateVmcSettings(payload: UpdateVmcSettingsPayload): Promise<ServerRecord> {
    const updated = await this.patchServer(payload.serverUuid, (server) => ({
      ...server,
      vmc: { ...server.vmc, ...payload.vmc },
      updatedAt: new Date().toISOString(),
    }));
    if (updated.vmc.enabled) {
      await this.writeVelocityConfiguration(updated);
    }
    return updated;
  }

  private async prepareServerFiles(server: PersistedServerRecord, javaExecutable: string): Promise<void> {
    const selectedVersion = await this.catalogService.findVersion(server.kind, server.version);
    if (!selectedVersion) {
      throw new Error(`Version ${server.version} introuvable pour ${server.kind}.`);
    }
    const runtimeDir = getRuntimeDirectory(server.rootDir, server.kind);
    const serverFileName = deriveFileNameFromUrl(selectedVersion.downloadUrl, `${server.kind}-${server.version}.jar`);
    const cachedServerJar = path.join(this.cacheDir, serverFileName);
    await downloadFile(selectedVersion.downloadUrl, cachedServerJar);
    if (server.kind === "forge" || server.kind === "neoforge") {
      const installerJar = path.join(runtimeDir, "installer.jar");
      await copyFile(cachedServerJar, installerJar);
      await this.ensureForgeLikeRuntimeInstalled(server, javaExecutable, runtimeDir, installerJar);
    } else {
      await copyFile(cachedServerJar, path.join(runtimeDir, "server.jar"));
    }
    await this.writeServerConfiguration(server);

    if (!server.vmc.enabled) {
      return;
    }

    const patchUrl = selectedVersion.vmc.patchUrl;
    if (!selectedVersion.vmc.compatible || !patchUrl) {
      throw new Error(`La version ${server.version} (${server.kind}) n'est pas compatible avec OpenVMC.`);
    }
    const patchFileName = deriveFileNameFromUrl(patchUrl, `openvmc-${server.kind}-${server.version}-patch.jar`);
    const cachedPatchFile = path.join(this.cacheDir, patchFileName);
    await downloadFile(patchUrl, cachedPatchFile);
    const addonsDir = getPaperPluginsDirectory(server);
    if (!addonsDir) {
      throw new Error("Impossible d'appliquer le patch VMC: aucun dossier plugins/mods pour ce type de serveur.");
    }
    await copyFile(cachedPatchFile, path.join(addonsDir, patchFileName));

    const velocityArtifact = await resolveVelocityArtifact();
    const cachedVelocityJar = path.join(this.cacheDir, velocityArtifact.fileName);
    await downloadFile(velocityArtifact.url, cachedVelocityJar);
    await copyFile(cachedVelocityJar, path.join(server.rootDir, "velocity", "velocity.jar"));
    await this.writeVelocityConfiguration(server);
  }

  private async resolveServerLaunch(
    server: PersistedServerRecord,
    runtimeDir: string,
  ): Promise<{ cwd: string; args: string[] }> {
    if (server.kind === "forge" || server.kind === "neoforge") {
      const unixArgsPath = await findForgeLikeUnixArgs(runtimeDir, server.kind);
      if (!unixArgsPath) {
        throw new Error(
          `Runtime ${server.kind} incomplet: unix_args.txt introuvable apres installation.`,
        );
      }
      const relativeUnixArgs = path.relative(runtimeDir, unixArgsPath);
      return {
        cwd: runtimeDir,
        args: [
          `-Xms${server.memoryMb}M`,
          `-Xmx${server.memoryMb}M`,
          `@${relativeUnixArgs}`,
        ],
      };
    }

    const serverJar = path.join(runtimeDir, "server.jar");
    return {
      cwd: runtimeDir,
      args: [`-Xms${server.memoryMb}M`, `-Xmx${server.memoryMb}M`, "-jar", serverJar, "--nogui"],
    };
  }

  private async ensureForgeLikeRuntimeInstalled(
    server: PersistedServerRecord,
    javaExecutable: string,
    runtimeDir: string,
    installerJar: string,
  ): Promise<void> {
    const existingUnixArgs = await findForgeLikeUnixArgs(runtimeDir, server.kind);
    if (existingUnixArgs) {
      return;
    }

    try {
      await execFileAsync(
        javaExecutable,
        ["-jar", installerJar, "--installServer", runtimeDir],
        {
          cwd: runtimeDir,
          maxBuffer: 20 * 1024 * 1024,
        },
      );
    } catch (error) {
      const typed = error as Error & { stderr?: string };
      const stderr = (typed.stderr ?? "").trim();
      throw new Error(
        `Installation ${server.kind} impossible: ${stderr || typed.message}`,
      );
    }

    const installedUnixArgs = await findForgeLikeUnixArgs(runtimeDir, server.kind);
    if (!installedUnixArgs) {
      throw new Error(`Installation ${server.kind} terminee mais unix_args.txt est introuvable.`);
    }
  }

  private async ensureServerLayout(server: PersistedServerRecord): Promise<void> {
    const runtimeDir = getRuntimeDirectory(server.rootDir, server.kind);
    await mkdir(server.rootDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    const addonsDir = getAddonsDirectory(server.rootDir, server.kind);
    if (addonsDir) {
      await mkdir(addonsDir, { recursive: true });
    }
    if (server.vmc.enabled) {
      await mkdir(path.join(server.rootDir, "velocity"), { recursive: true });
      await mkdir(path.join(server.rootDir, "velocity", "plugins"), { recursive: true });
    }
  }

  private async writeServerConfiguration(server: PersistedServerRecord): Promise<void> {
    const runtimeDir = getRuntimeDirectory(server.rootDir, server.kind);
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "eula.txt"), "eula=true\n", "utf8");
    await writeFile(path.join(runtimeDir, "server.properties"), buildPaperProperties(server), "utf8");
  }

  private async writeVelocityConfiguration(server: PersistedServerRecord): Promise<void> {
    if (server.velocityPort === null) {
      return;
    }

    const velocityDir = path.join(server.rootDir, "velocity");
    await mkdir(velocityDir, { recursive: true });
    await writeFile(path.join(velocityDir, "velocity.toml"), buildVelocityToml(server), "utf8");
  }

  private spawnProcess(
    server: PersistedServerRecord,
    runtime: RuntimeState,
    name: "paper" | "velocity",
    executable: string,
    args: string[],
    cwd: string,
  ): RuntimeProcess {
    const child = spawn(executable, args, {
      cwd,
      stdio: "pipe",
    });

    child.stdout.on("data", (chunk) => {
      appendOutput(runtime, "info", chunk.toString("utf8"), this.emitEvent, server.serverUuid);
    });
    child.stderr.on("data", (chunk) => {
      appendOutput(runtime, "error", chunk.toString("utf8"), this.emitEvent, server.serverUuid);
    });

    child.on("close", async (code) => {
      appendOutput(runtime, code === 0 ? "info" : "error", `Process exited with code ${code ?? 0}`, this.emitEvent, server.serverUuid);
      delete runtime.processes[name];

      if (!runtime.isStopping) {
        runtime.isStopping = true;
        this.stopStatsPolling(runtime);
        const otherProcesses = Object.values(runtime.processes).filter(Boolean) as RuntimeProcess[];
        for (const other of otherProcesses) {
          other.child.kill("SIGTERM");
        }
        this.consoleHistory.set(server.serverUuid, [...runtime.consoleLines]);
        this.runtimes.delete(server.serverUuid);
        if (this.activeServerId === server.serverUuid) {
          this.activeServerId = null;
        }
        await this.patchServer(server.serverUuid, (current) => ({
          ...current,
          status: code === 0 ? "stopped" : "error",
          updatedAt: new Date().toISOString(),
        }));
        this.emitEvent({ type: "state-changed", serverUuid: server.serverUuid });
      }
    });

    return { name, child };
  }

  private appendConsoleLine(runtime: RuntimeState, level: ConsoleLine["level"], text: string): void {
    runtime.consoleLines.push({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      text,
    });
    if (runtime.consoleLines.length > MAX_CONSOLE_LINES) {
      runtime.consoleLines.splice(0, runtime.consoleLines.length - MAX_CONSOLE_LINES);
    }
  }

  private startStatsPolling(server: PersistedServerRecord, runtime: RuntimeState): void {
    runtime.statsTimer = setInterval(() => {
      this.refreshRuntimeStats(server, runtime).catch((err) => {
        console.error(`Stats polling failed for ${server.serverUuid}:`, err);
      });
    }, STATS_REFRESH_INTERVAL_MS);
  }

  private stopStatsPolling(runtime: RuntimeState): void {
    if (runtime.statsTimer) {
      clearInterval(runtime.statsTimer);
      runtime.statsTimer = null;
    }
  }

  private async refreshRuntimeStats(server: PersistedServerRecord, runtime: RuntimeState): Promise<void> {
    const pids = Object.values(runtime.processes)
      .filter((process): process is RuntimeProcess => Boolean(process))
      .map((process) => process.child.pid)
      .filter((pid): pid is number => typeof pid === "number" && pid > 0);

    const processStats = pids.length > 0 ? await collectProcessStats(pids) : { cpuPercent: 0, ramUsedMb: 0 };
    
    // On ne recalcule le stockage que toutes les 30 secondes pour économiser les ressources
    let storageMb = runtime.stats.storageMb;
    const now = Date.now();
    if (!runtime.lastStorageCheck || now - runtime.lastStorageCheck > 30_000) {
      storageMb = Math.ceil((await measureDirectoryBytes(server.rootDir)) / (1024 * 1024));
      runtime.lastStorageCheck = now;
    }

    runtime.stats = {
      uptimeSeconds: runtime.startedAt ? Math.max(0, Math.floor((Date.now() - runtime.startedAt) / 1000)) : 0,
      cpuPercent: processStats.cpuPercent,
      cpuLimitPercent: 100,
      ramUsedMb: processStats.ramUsedMb,
      ramLimitMb: getRamLimitMb(server),
      storageMb,
    };
    this.emitEvent({ type: "server-updated", serverUuid: server.serverUuid });
  }

  private requireServer(serverUuid: string): PersistedServerRecord {
    const server = this.stateStore.findServer(serverUuid);
    if (!server) {
      throw new Error("Server not found");
    }
    return server;
  }

  private async patchServer(
    serverUuid: string,
    updater: (server: PersistedServerRecord) => PersistedServerRecord,
  ): Promise<PersistedServerRecord> {
    const updated = await this.stateStore.updateServer(serverUuid, updater);
    this.emitEvent({ type: "server-updated", serverUuid });
    return updated;
  }

  async resolveSafePath(serverUuid: string, relativePath: string): Promise<string> {
    const server = this.requireServer(serverUuid);
    const sanitized = relativePath.trim();
    if (!sanitized) return server.rootDir;
    const normalized = path.normalize(sanitized);
    const absolutePath = path.resolve(server.rootDir, normalized);
    const rootDir = path.resolve(server.rootDir);
    if (absolutePath !== rootDir && !absolutePath.startsWith(`${rootDir}${path.sep}`)) {
      throw new Error("Acces fichier refuse.");
    }
    return absolutePath;
  }

  async deleteServerFiles(serverUuid: string, relativePaths: string[]): Promise<void> {
    for (const relPath of relativePaths) {
      const absPath = await this.resolveSafePath(serverUuid, relPath);
      await rm(absPath, { recursive: true, force: true });
    }
    this.emitEvent({ type: "server-updated", serverUuid });
  }

  async copyServerFiles(serverUuid: string, relativePaths: string[], destRelativePath: string): Promise<void> {
    const destDir = await this.resolveSafePath(serverUuid, destRelativePath);
    for (const relPath of relativePaths) {
      const srcPath = await this.resolveSafePath(serverUuid, relPath);
      const name = path.basename(srcPath);
      const targetPath = path.join(destDir, name);
      await cp(srcPath, targetPath, { recursive: true });
    }
    this.emitEvent({ type: "server-updated", serverUuid });
  }

  async moveServerFiles(serverUuid: string, relativePaths: string[], destRelativePath: string): Promise<void> {
    const destDir = await this.resolveSafePath(serverUuid, destRelativePath);
    for (const relPath of relativePaths) {
      const srcPath = await this.resolveSafePath(serverUuid, relPath);
      const name = path.basename(srcPath);
      const targetPath = path.join(destDir, name);
      await rename(srcPath, targetPath);
    }
    this.emitEvent({ type: "server-updated", serverUuid });
  }

  async createServerDirectory(serverUuid: string, relativePath: string): Promise<void> {
    const absPath = await this.resolveSafePath(serverUuid, relativePath);
    await mkdir(absPath, { recursive: true });
    this.emitEvent({ type: "server-updated", serverUuid });
  }

  async uploadServerFiles(serverUuid: string, filePaths: string[], destRelativePath: string): Promise<void> {
    const destDir = await this.resolveSafePath(serverUuid, destRelativePath);
    await mkdir(destDir, { recursive: true });
    for (const srcPath of filePaths) {
      const name = path.basename(srcPath);
      const targetPath = path.join(destDir, name);
      await cp(srcPath, targetPath, { recursive: true });
    }
    this.emitEvent({ type: "server-updated", serverUuid });
  }

  private async resolveEditableFilePath(server: PersistedServerRecord, relativePath: string): Promise<string> {
    const sanitized = relativePath.trim();
    if (!sanitized) {
      throw new Error("Chemin de fichier invalide.");
    }

    const normalized = path.normalize(sanitized);
    const absolutePath = path.resolve(server.rootDir, normalized);
    const rootDir = path.resolve(server.rootDir);
    if (absolutePath !== rootDir && !absolutePath.startsWith(`${rootDir}${path.sep}`)) {
      throw new Error("Acces fichier refuse.");
    }

    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      throw new Error("Seuls les fichiers peuvent etre ouverts.");
    }

    return absolutePath;
  }

  private async resolveWritableFilePath(server: PersistedServerRecord, relativePath: string): Promise<string> {
    const sanitized = relativePath.trim();
    if (!sanitized) {
      throw new Error("Chemin de fichier invalide.");
    }

    const normalized = path.normalize(sanitized);
    const absolutePath = path.resolve(server.rootDir, normalized);
    const rootDir = path.resolve(server.rootDir);
    if (absolutePath !== rootDir && !absolutePath.startsWith(`${rootDir}${path.sep}`)) {
      throw new Error("Acces fichier refuse.");
    }

    const targetName = path.basename(absolutePath);
    if (!targetName || targetName === "." || targetName === "..") {
      throw new Error("Nom de fichier invalide.");
    }

    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        throw new Error("Seuls les fichiers peuvent etre modifies.");
      }
    } catch (error) {
      const typedError = error as NodeJS.ErrnoException;
      if (typedError.code && typedError.code !== "ENOENT") {
        throw error;
      }
    }

    return absolutePath;
  }

  async findAvailablePort(startPort: number): Promise<number> {
    let port = startPort;
    // On vérifie aussi les ports déjà attribués en base
    const usedPorts = new Set(
      this.stateStore.getServers().flatMap(s => [s.paperPort, s.velocityPort].filter(Boolean) as number[])
    );

    while (port < 65535) {
      if (!usedPorts.has(port)) {
        const isFree = await checkPortAvailability(port);
        if (isFree) return port;
      }
      port++;
    }
    throw new Error("Aucun port disponible trouve.");
  }

  async cleanupZombieProcesses(): Promise<void> {
    const serversDir = this.stateStore.getPaths().serversDir;
    try {
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync("wmic", ["process", "where", "name='java.exe'", "get", "commandline,processid"]);
        const lines = stdout.split(/\r?\n/).slice(1).filter(Boolean);
        for (const line of lines) {
          if (line.includes(serversDir) && (line.includes("server.jar") || line.includes("velocity.jar"))) {
            const match = line.match(/(\d+)\s*$/);
            if (match) {
              process.kill(Number.parseInt(match[1], 10), "SIGTERM");
            }
          }
        }
      } else {
        const { stdout } = await execFileAsync("ps", ["-eo", "pid,command"]);
        const lines = stdout.split(/\r?\n/).slice(1).filter(Boolean);
        const myPid = process.pid;
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.includes(serversDir) && (trimmed.includes("server.jar") || trimmed.includes("velocity.jar"))) {
            const pid = Number.parseInt(trimmed.split(/\s+/)[0], 10);
            if (!Number.isNaN(pid) && pid !== myPid) {
              process.kill(pid, "SIGTERM");
            }
          }
        }
      }
    } catch (err) {
      console.warn("Echec du nettoyage des processus fantomes:", err);
    }
  }
}

function checkPortAvailability(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
      } else {
        resolve(true); // Autre erreur, on assume que c'est ok ou géré plus tard
      }
    });
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, "127.0.0.1");
  });
}

function appendOutput(
  runtime: RuntimeState,
  level: ConsoleLine["level"],
  raw: string,
  emitEvent: (event: LauncherEvent) => void,
  serverUuid: string,
): void {
  for (const line of raw
    .split(/\r?\n/)
    .map((entry) => stripAnsi(entry).trimEnd())
    .filter((entry) => entry.trim().length > 0)) {
    runtime.consoleLines.push({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      text: line,
    });
  }

  if (runtime.consoleLines.length > MAX_CONSOLE_LINES) {
    runtime.consoleLines.splice(0, runtime.consoleLines.length - MAX_CONSOLE_LINES);
  }

  emitEvent({ type: "server-updated", serverUuid });
}

function buildInitialStats(server: PersistedServerRecord): ServerStats {
  return {
    uptimeSeconds: 0,
    cpuPercent: 0,
    cpuLimitPercent: 100,
    ramUsedMb: 0,
    ramLimitMb: getRamLimitMb(server),
    storageMb: 0,
  };
}

async function waitForProcessExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve();
    }, timeoutMs);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function findForgeLikeUnixArgs(
  runtimeDir: string,
  kind: PersistedServerRecord["kind"],
): Promise<string | null> {
  const root = kind === "forge"
    ? path.join(runtimeDir, "libraries", "net", "minecraftforge", "forge")
    : path.join(runtimeDir, "libraries", "net", "neoforged", "neoforge");

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (entry.isFile() && entry.name === "unix_args.txt") {
        return absolutePath;
      }
    }
  }

  return null;
}

function buildPaperProperties(server: PersistedServerRecord): string {
  const onlineMode = server.vmc.enabled ? "false" : "true";
  const serverIp = server.vmc.enabled ? "127.0.0.1" : "";

  return [
    `motd=${escapePropertiesValue(server.settings.motd)}`,
    `difficulty=${server.settings.difficulty}`,
    `gamemode=${server.settings.gamemode}`,
    `max-players=${server.settings.maxPlayers}`,
    `max-tick-time=${server.settings.maxTickTime}`,
    `max-world-size=${server.settings.maxWorldSize}`,
    `pvp=${server.settings.pvp}`,
    `spawn-protection=${server.settings.spawnProtection}`,
    `rate-limit=${server.settings.rateLimit}`,
    `view-distance=${server.settings.viewDistance}`,
    `simulation-distance=${server.settings.simulationDistance}`,
    `server-port=${server.paperPort}`,
    `online-mode=${onlineMode}`,
    `server-ip=${serverIp}`,
    "enable-query=false",
    "enable-rcon=false",
    "sync-chunk-writes=true",
  ].join("\n").concat("\n");
}

function getRamLimitMb(server: PersistedServerRecord): number {
  return server.memoryMb + (server.vmc.enabled ? 512 : 0);
}

function deriveFileNameFromUrl(url: string, fallbackName: string): string {
  try {
    const parsed = new URL(url);
    const fileName = path.basename(parsed.pathname);
    return fileName || fallbackName;
  } catch {
    return fallbackName;
  }
}

async function collectProcessStats(pids: number[]): Promise<Pick<ServerStats, "cpuPercent" | "ramUsedMb">> {
  try {
    if (process.platform === "win32") {
      return collectWindowsProcessStats(pids);
    }
    return collectPosixProcessStats(pids);
  } catch {
    return { cpuPercent: 0, ramUsedMb: 0 };
  }
}

async function collectPosixProcessStats(pids: number[]): Promise<Pick<ServerStats, "cpuPercent" | "ramUsedMb">> {
  const { stdout } = await execFileAsync("ps", ["-o", "pid=,%cpu=,rss=", "-p", pids.join(",")]);
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const cpuCores = Math.max(1, availableParallelism());
  let totalCpu = 0;
  let totalRssKb = 0;

  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 3) {
      continue;
    }
    totalCpu += Number.parseFloat(parts[1]) || 0;
    totalRssKb += Number.parseInt(parts[2] ?? "0", 10) || 0;
  }

  return {
    cpuPercent: Math.max(0, Math.round((totalCpu / cpuCores) * 10) / 10),
    ramUsedMb: Math.max(0, Math.round(totalRssKb / 1024)),
  };
}

async function collectWindowsProcessStats(pids: number[]): Promise<Pick<ServerStats, "cpuPercent" | "ramUsedMb">> {
  // On utilise Get-Process pour la RAM (WorkingSet64)
  // Pour le CPU on utilise Win32_PerfFormattedData_PerfProc_Process qui est déjà formaté en pourcentage
  const powershellScript = [
    `$ids = @(${pids.join(",")})`,
    "$p = Get-Process -Id $ids -ErrorAction SilentlyContinue",
    "if ($p) {",
    "  $ws = ($p | Measure-Object -Property WorkingSet64 -Sum).Sum",
    "  $cpu = (Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.IDProcess } | Measure-Object -Property PercentProcessorTime -Sum).Sum",
    "  \"$cpu|$ws\"",
    "} else { \"0|0\" }"
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell", [
      "-NoProfile",
      "-Command",
      powershellScript,
    ]);

    const [cpuRaw, wsRaw] = stdout.trim().split("|");
    const totalCpu = Number.parseFloat(cpuRaw?.replace(',', '.') || "0");
    const totalWs = Number.parseInt(wsRaw || "0", 10);
    const cpuCores = Math.max(1, availableParallelism());

    return {
      cpuPercent: Math.max(0, Math.round((totalCpu / cpuCores) * 10) / 10),
      ramUsedMb: Math.max(0, Math.round(totalWs / (1024 * 1024))),
    };
  } catch {
    return { cpuPercent: 0, ramUsedMb: 0 };
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function buildVelocityToml(server: PersistedServerRecord): string {
  if (server.velocityPort === null) {
    throw new Error("Velocity port missing for proxy server.");
  }

  return [
    'config-version = "2.7"',
    `bind = "0.0.0.0:${server.velocityPort}"`,
    `motd = "<green>${escapeMiniMessage(server.settings.motd)}"`,
    "show-max-players = 500",
    "online-mode = true",
    "force-key-authentication = true",
    'player-info-forwarding-mode = "none"',
    'forwarding-secret-file = "forwarding.secret"',
    "announce-forge = false",
    "kick-existing-players = false",
    'ping-passthrough = "DISABLED"',
    "",
    "[servers]",
    `paper = "127.0.0.1:${server.paperPort}"`,
    'try = ["paper"]',
    "",
    "[forced-hosts]",
    "",
    "[advanced]",
    "compression-threshold = 256",
    "compression-level = -1",
    "login-ratelimit = 3000",
    "connection-timeout = 5000",
    "read-timeout = 30000",
    "haproxy-protocol = false",
    "tcp-fast-open = false",
    "bungee-plugin-message-channel = true",
    "show-ping-requests = false",
    "failover-on-unexpected-server-disconnect = true",
    "announce-proxy-commands = true",
    "log-command-executions = false",
    "log-player-connections = true",
    "accepts-transfers = false",
    "enable-reuse-port = false",
    "command-rate-limit = 50",
    "forward-commands-if-rate-limited = true",
    "kick-after-rate-limited-commands = 0",
    "tab-complete-rate-limit = 10",
    "kick-after-rate-limited-tab-completes = 0",
  ].join("\n").concat("\n");
}

function escapePropertiesValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, " ");
}

function escapeMiniMessage(value: string): string {
  return value.replace(/[<>]/g, "");
}

async function readManagedFiles(rootDir: string) {
  const results: ServerDetails["files"] = [];
  await walkManagedFiles(rootDir, rootDir, results);
  return results.sort((left, right) => left.path.localeCompare(right.path));
}

async function walkManagedFiles(rootDir: string, currentDir: string, results: ServerDetails["files"]): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[ServerManager] Impossible de lire le dossier ${currentDir}:`, err);
    return;
  }

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    try {
      const fileStat = await stat(absolutePath);
      const relativePath = path.relative(rootDir, absolutePath) || entry.name;
      
      results.push({
        name: entry.name,
        path: relativePath,
        kind: entry.isDirectory() ? "directory" : "file",
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
      });

      // On limite la récursion pour éviter de scanner tout le disque si un lien symbolique traîne
      if (entry.isDirectory() && relativePath.split(path.sep).length < 4) {
        await walkManagedFiles(rootDir, absolutePath, results);
      }
    } catch (err) {
      // Le fichier a pu être supprimé entre le readdir et le stat (fréquent sur MC)
      console.debug(`[ServerManager] Fichier ignoré (disparu): ${absolutePath}`);
      continue;
    }
  }
}

async function measureDirectoryBytes(rootDir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      total += await measureDirectoryBytes(entryPath);
    } else {
      total += (await stat(entryPath)).size;
    }
  }

  return total;
}
