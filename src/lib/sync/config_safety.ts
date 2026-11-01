import { normalizePath } from "obsidian";
import type FastSync from "../../main";
import { getPluginDir } from "../utils/helpers";

/** Device-local holds survive restart and never travel through either sync channel. */
export class ConfigSafety {
    private held = new Set<string>();
    private reportedConflicts = new Set<string>();
    private loaded: Promise<void> | null = null;
    private writes: Promise<void> = Promise.resolve();
    private baselines = new Map<string, string>();
    public initialRound = false;

    constructor(private plugin: FastSync) {}

    private get indexPath(): string {
        return normalizePath(`${getPluginDir(this.plugin)}/config-delete-conflicts.json`);
    }

    async initialize(): Promise<void> {
        if (!this.loaded) this.loaded = this.load();
        await this.loaded;
    }

    private async load(): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        const journal = this.indexPath + ".tmp";
        const source = await adapter.exists(journal) ? journal : this.indexPath;
        if (!(await adapter.exists(source))) return;
        const value: unknown = JSON.parse(await adapter.read(source));
        if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1
            || !("held" in value) || !Array.isArray(value.held)
            || !value.held.every((p: unknown) => typeof p === "string")
            || !("confirmed" in value) || !value.confirmed || typeof value.confirmed !== "object"
            || !Object.values(value.confirmed).every((hash: unknown) => typeof hash === "string")) {
            throw new Error("Invalid local configuration conflict index; synchronization stopped.");
        }
        this.held = new Set(value.held);
        this.baselines = new Map(Object.entries(value.confirmed) as [string, string][]);
    }

    async beginRound(): Promise<void> {
        await this.initialize();
        this.reportedConflicts.clear();
        this.initialRound = Number(this.plugin.localStorageManager.getMetadata("lastConfigSyncTime")) === 0;
    }

    countConflict(path: string): boolean {
        if (this.reportedConflicts.has(path)) return false;
        this.reportedConflicts.add(path);
        return true;
    }

    baseline(path: string): string | null {
        // The original hash cache can be rebuilt from unsynced local files. Only
        // a completed download or server upload acknowledgement establishes this baseline.
        return this.baselines.get(path) ?? null;
    }

    async paths(): Promise<string[]> {
        await this.initialize();
        return Array.from(this.held);
    }

    async has(path: string): Promise<boolean> {
        await this.initialize();
        return this.held.has(path);
    }

    private change(path: string, hold?: boolean, hash?: string): Promise<void> {
        const operation = this.writes.then(async () => {
            await this.initialize();
            const next = new Set(this.held);
            if (hold === true) next.add(path); else if (hold === false) next.delete(path);
            const confirmed = new Map(this.baselines);
            if (hash !== undefined) confirmed.set(path, hash);
            const adapter = this.plugin.app.vault.adapter;
            const temporary = this.indexPath + ".tmp";
            const serialized = JSON.stringify({ version: 1, held: Array.from(next), confirmed: Object.fromEntries(confirmed) });
            // Obsidian's adapter.rename does not replace existing files. Keep a complete
            // journal until the main write succeeds, so interruption can recover from it.
            await adapter.write(temporary, serialized);
            this.held = next;
            await adapter.write(this.indexPath, serialized);
            this.baselines = confirmed;
            await adapter.remove(temporary);
        });
        this.writes = operation.catch(() => {});
        return operation;
    }

    confirm(path: string, hash: string): Promise<void> { return this.change(path, undefined, hash); }
    hold(path: string): Promise<void> { return this.change(path, true); }
    release(path: string): Promise<void> { return this.change(path, false); }
}
