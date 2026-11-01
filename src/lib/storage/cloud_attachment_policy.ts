import type { PluginSettings } from "../../setting";

export const CLOUD_MEDIA_EXTENSIONS = {
    image: [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".webp", ".wximage"],
    audio: [".mp3", ".wav", ".ogg", ".m4a", ".flac"],
    video: [".mp4", ".webm", ".mov", ".avi"],
    pdf: [".pdf"],
};
export type CloudMediaType = keyof typeof CLOUD_MEDIA_EXTENSIONS;
export const MAX_CLOUD_ONLY_MB = 20;

export function normalizeCloudPath(path: string): string {
    const parts: string[] = [];
    for (const part of path.replace(/\\/g, "/").split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") parts.pop(); else parts.push(part);
    }
    return parts.join("/");
}

/** One policy controls both cloud-only downloads and local cleanup. Unknown sizes stay local. */
export function isCloudOnlyEligible(path: string, size: number | undefined, settings: PluginSettings): boolean {
    if (!settings.cloudPreviewEnabled || !Number.isSafeInteger(size) || size === undefined || size <= 0) return false;
    const limit = settings.cloudPreviewMaxSizeMb;
    if (!Number.isFinite(limit) || limit <= 0 || limit > MAX_CLOUD_ONLY_MB || size > limit * 1024 * 1024) return false;
    const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
    const types: unknown = settings.cloudPreviewMediaTypes;
    return Array.isArray(types) && types.some((type: unknown) => typeof type === "string"
        && Object.prototype.hasOwnProperty.call(CLOUD_MEDIA_EXTENSIONS, type)
        && CLOUD_MEDIA_EXTENSIONS[type as CloudMediaType].includes(ext));
}
