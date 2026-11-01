import { Modal, Setting } from "obsidian";
import type FastSync from "../main";
import { $ } from "../i18n/lang";
import { configModify, receiveConfigSyncDelete } from "../lib/sync/operator_config";
import { showSyncNotice } from "../lib/utils/helpers";

export class ConfigDeleteConflictsModal extends Modal {
    private resolving = false;
    constructor(private plugin: FastSync) { super(plugin.app); }

    onOpen(): void { void this.render(); }

    private async render(): Promise<void> {
        this.contentEl.empty();
        this.setTitle($("config_safety.title"));
        this.contentEl.createEl("p", { text: $("config_safety.explanation") });
        const paths = await this.plugin.configSafety.paths();
        if (paths.length === 0) this.contentEl.createEl("p", { text: $("config_safety.empty") });
        for (const path of paths) {
            const row = new Setting(this.contentEl).setName(path);
            for (const keep of [true, false]) {
                row.addButton(button => button.setButtonText($(keep ? "config_safety.keep" : "config_safety.delete"))
                    .onClick(async () => {
                        if (this.resolving) return;
                        if (!this.plugin.settings.configSyncEnabled || this.plugin.syncState.activeSyncContext || (keep && (!this.plugin.websocket.isAuth || this.plugin.settings.readonlySyncEnabled))) {
                            showSyncNotice($("config_safety.wait"));
                            return;
                        }
                        this.resolving = true;
                        button.setDisabled(true);
                        try {
                            if (keep) {
                                // Persist pending intent before releasing the hold. The normal Ack path
                                // then confirms the upload, including after a connection interruption.
                                await configModify(path, this.plugin, false, undefined, true);
                            } else {
                                await receiveConfigSyncDelete({ path }, this.plugin, true);
                            }
                            await this.plugin.configSafety.release(path);
                            await this.render();
                        } catch {
                            showSyncNotice($("config_safety.resolve_failed"));
                            button.setDisabled(false);
                        } finally {
                            this.resolving = false;
                        }
                    }));
            }
        }
    }

    onClose(): void { this.contentEl.empty(); }
}
