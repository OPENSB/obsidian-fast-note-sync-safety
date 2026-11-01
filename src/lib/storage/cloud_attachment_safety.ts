import type FastSync from "../../main";
import { getPluginDir, hashArrayBuffer } from "../utils/helpers";
import { isCloudOnlyEligible, normalizeCloudPath } from "./cloud_attachment_policy";

interface CloudEntry { scope: string; path: string; sha256: string; size: number }
interface UploadSnapshot extends CloudEntry { hash: string; mtime: number; token: string }

/** Device-local eviction journal. An evicted file is never an offline cloud deletion. */
export class CloudAttachmentSafety {
    private entries = new Map<string, CloudEntry>();
    private pending = new Map<string, UploadSnapshot>();
    private loaded: Promise<void> | null = null;
    private writes = Promise.resolve();
    private cleanupQueue: Promise<unknown> = Promise.resolve();
    private stopped = false;

    constructor(private plugin: FastSync) {}

    private scope(): string { return JSON.stringify([this.plugin.settings.api.replace(/\/+$/, ""), this.plugin.settings.vault]); }
    private key(path: string): string { return JSON.stringify([this.scope(), path]); }
    private indexPath(): string { return `${getPluginDir(this.plugin)}/cloud-attachments.json`; }

    async initialize(): Promise<void> {
        if (!this.loaded) this.loaded = this.load();
        return this.loaded;
    }

    private async load(): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        const temporary = this.indexPath() + ".tmp";
        const source = await adapter.exists(temporary) ? temporary : this.indexPath();
        if (!await adapter.exists(source)) return;
        const value: unknown = JSON.parse(await adapter.read(source));
        if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1
            || !("entries" in value) || !Array.isArray(value.entries)) throw new Error("Invalid cloud attachment journal; cleanup and deletion scan stopped.");
        for (const entry of value.entries as unknown[]) {
            if (!entry || typeof entry !== "object" || !("scope" in entry) || typeof entry.scope !== "string"
                || !("path" in entry) || typeof entry.path !== "string" || !("sha256" in entry) || typeof entry.sha256 !== "string"
                || !("size" in entry) || typeof entry.size !== "number") throw new Error("Invalid cloud attachment journal entry.");
            const record = entry as CloudEntry;
            this.entries.set(JSON.stringify([record.scope, record.path]), record);
        }
    }

    private change(key: string, entry?: CloudEntry): Promise<void> {
        const operation = this.writes.then(async () => {
            await this.initialize();
            const next = new Map(this.entries);
            if (entry) next.set(key, entry); else next.delete(key);
            const serialized = JSON.stringify({ version: 1, entries: Array.from(next.values()) });
            const adapter = this.plugin.app.vault.adapter;
            await adapter.write(this.indexPath() + ".tmp", serialized);
            this.entries = next;
            await adapter.write(this.indexPath(), serialized);
            await adapter.remove(this.indexPath() + ".tmp");
        });
        this.writes = operation.catch(() => {});
        return operation;
    }

    protects(path: string): boolean {
        return Array.from(this.entries.values()).some(entry => entry.scope === this.scope()
            && (entry.path === path || entry.path.startsWith(path + "/")));
    }

    resolvePath(linkPath: string, sourcePath: string): string | null {
        const paths = Array.from(this.entries.values()).filter(entry => entry.scope === this.scope()).map(entry => entry.path);
        const direct = normalizeCloudPath(linkPath);
        const folder = sourcePath.split("/").slice(0, -1).join("/");
        const relative = normalizeCloudPath(`${folder}/${linkPath}`);
        const candidates = linkPath.startsWith(".") || !linkPath.includes("/") ? [relative, direct] : [direct, relative];
        for (const candidate of candidates) if (paths.includes(candidate)) return candidate;
        const matches = paths.filter(path => path.split("/").at(-1) === direct);
        return matches.length === 1 ? matches[0] : null;
    }

    knownSize(path: string): number | undefined { return this.entries.get(this.key(path))?.size; }

    async localPresent(path: string): Promise<void> {
        await this.initialize();
        if (!this.plugin.app.vault.getFileByPath(path)) return;
        if (this.entries.has(this.key(path))) await this.change(this.key(path));
    }

    private async sha256(bytes: ArrayBuffer): Promise<string> {
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    }

    async prepareUpload(path: string, hash: string, bytes?: ArrayBuffer): Promise<void> {
        this.pending.delete(path);
        const file = this.plugin.app.vault.getFileByPath(path);
        if (this.stopped || !file || !this.plugin.settings.cloudPreviewAutoDeleteLocal
            || !isCloudOnlyEligible(path, file.stat.size, this.plugin.settings)) return;
        const scope = this.scope(), token = this.plugin.settings.apiToken, mtime = file.stat.mtime, size = file.stat.size;
        const content = bytes ?? await this.plugin.app.vault.readBinary(file);
        if (content.byteLength !== size || await hashArrayBuffer(content) !== hash) return;
        const sha256 = await this.sha256(content);
        if (this.scope() !== scope || this.plugin.settings.apiToken !== token) return;
        this.pending.set(path, { scope, token, path, hash, sha256, size, mtime });
    }

    afterUploadAck(path: string, hash: string | undefined): Promise<boolean> {
        const snapshot = this.pending.get(path);
        if (!snapshot || snapshot.hash !== hash) return Promise.resolve(false);
        this.pending.delete(path);
        const operation = this.cleanupQueue.then(() => this.verifyAndClean(snapshot));
        this.cleanupQueue = operation.catch(() => {});
        return operation;
    }

    afterServerFileExists(path: string, hash: string | undefined): Promise<boolean> {
        const snapshot = this.pending.get(path);
        const file = this.plugin.app.vault.getFileByPath(path);
        // The server's deduplication response updates local timestamps without a new
        // binary upload. Full SHA-256 comparisons still establish content equality.
        if (snapshot && snapshot.hash === hash && file) snapshot.mtime = file.stat.mtime;
        return this.afterUploadAck(path, hash);
    }

    async confirmExistingUpload(path: string, hash: string): Promise<boolean> {
        const snapshot = this.pending.get(path);
        if (!snapshot || snapshot.hash !== hash || !this.stillAllowed(snapshot)) return false;
        // A deduplicated upload can receive an unaddressed NoUpdate response instead
        // of FileUploadAck. An authenticated metadata read confirms the stored file;
        // the same full read-back/local SHA-256 checks are still mandatory below.
        let info;
        try { info = await this.plugin.api.getFileInfo(path); } catch { return false; }
        if (!info || info.isRecycle || info.path !== path || info.size !== snapshot.size
            || info.contentHash !== hash || this.pending.get(path) !== snapshot) return false;
        return this.afterServerFileExists(path, hash);
    }

    private stillAllowed(snapshot: UploadSnapshot): boolean {
        return !this.stopped && snapshot.scope === this.scope() && snapshot.token === this.plugin.settings.apiToken
            && this.plugin.settings.syncEnabled && !this.plugin.settings.readonlySyncEnabled
            && this.plugin.settings.cloudPreviewAutoDeleteLocal
            && !this.plugin.settings.cloudPreviewRemoteUrl?.trim()
            && isCloudOnlyEligible(snapshot.path, snapshot.size, this.plugin.settings);
    }

    private async verifyAndClean(snapshot: UploadSnapshot): Promise<boolean> {
        await this.initialize();
        if (!this.stillAllowed(snapshot)) return false;
        const info = await this.plugin.api.getFileInfo(snapshot.path);
        if (!info || info.isRecycle || info.path !== snapshot.path || info.size !== snapshot.size || info.contentHash !== snapshot.hash) return false;
        // The protocol's rolling/sampled hash is insufficient for deletion. Read back the
        // bounded small file and compare SHA-256 across all bytes, including the middle.
        const remote = await this.plugin.api.getFileContentForVerification(snapshot.path, snapshot.size);
        if (await this.sha256(remote) !== snapshot.sha256) return false;
        const finalInfo = await this.plugin.api.getFileInfo(snapshot.path);
        if (!finalInfo || finalInfo.isRecycle || finalInfo.path !== info.path || finalInfo.size !== info.size
            || finalInfo.contentHash !== info.contentHash || finalInfo.updatedAt !== info.updatedAt) return false;

        return (await this.plugin.lockManager.withLock(snapshot.path, async () => {
            const file = this.plugin.app.vault.getFileByPath(snapshot.path);
            if (!this.stillAllowed(snapshot) || !file || file.stat.size !== snapshot.size || file.stat.mtime !== snapshot.mtime) return false;
            if (await this.sha256(await this.plugin.app.vault.readBinary(file)) !== snapshot.sha256) return false;
            if (!this.stillAllowed(snapshot) || file.stat.size !== snapshot.size || file.stat.mtime !== snapshot.mtime) return false;
            const key = JSON.stringify([snapshot.scope, snapshot.path]);
            // Persist BEFORE the host emits delete events, including delayed callbacks.
            // The journal also protects the next full scan after a crash or restart.
            try {
                await this.change(key, { scope: snapshot.scope, path: snapshot.path, sha256: snapshot.sha256, size: snapshot.size });
                if (!this.stillAllowed(snapshot) || file.path !== snapshot.path
                    || this.plugin.app.vault.getFileByPath(snapshot.path) !== file
                    || file.stat.size !== snapshot.size || file.stat.mtime !== snapshot.mtime) return false;
                if (await this.sha256(await this.plugin.app.vault.readBinary(file)) !== snapshot.sha256) return false;
                if (!this.stillAllowed(snapshot) || file.path !== snapshot.path
                    || this.plugin.app.vault.getFileByPath(snapshot.path) !== file
                    || file.stat.size !== snapshot.size || file.stat.mtime !== snapshot.mtime) return false;
                await this.plugin.app.fileManager.trashFile(file);
                this.plugin.fileHashManager.removeFileHash(snapshot.path);
                this.plugin.fileHashManager.flush();
                return true;
            } finally {
                // Failed/cancelled cleanup must not suppress a later deliberate deletion.
                if (this.plugin.app.vault.getFileByPath(snapshot.path)) await this.change(key);
            }
        })) === true;
    }

    stop(): void { this.stopped = true; this.pending.clear(); }
}
