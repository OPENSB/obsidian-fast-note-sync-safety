function redactText(text: string): string {
    return text
        .replace(/([?&](?:token|apiToken|access_token|authorization|password|secret)=)[^&#\s"']*/gi, "$1[redacted]")
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]");
}

/** Keep diagnostics useful without logging credentials, note bodies or binary content. */
export function formatDiagnostic(value: unknown): string {
    const seen = new WeakSet<object>();
    const visit = (item: unknown, key = ""): unknown => {
        if (/(?:token|password|authorization|secret|cookie|privatekey)/i.test(key)) return "[redacted]";
        if (/^(?:content|body|localContent|remoteContent|noteContent|diffs)$/i.test(key)) return "[content omitted]";
        if (item instanceof Error) return { name: item.name, message: redactText(item.message) };
        if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) return "[binary omitted]";
        if (typeof item === "string") {
            const trimmed = item.trimStart();
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                try { return visit(JSON.parse(item) as unknown); } catch { /* Ordinary diagnostic text. */ }
            }
            return redactText(item);
        }
        if (item && typeof item === "object") {
            if (seen.has(item)) return "[circular]";
            seen.add(item);
            if (Array.isArray(item)) return item.map(value => visit(value));
            return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, visit(value, key)]));
        }
        return typeof item === "bigint" ? String(item) : item;
    };
    const result = visit(value);
    if (typeof result === "string") return result;
    try { return JSON.stringify(result) ?? String(result); } catch { return "[unserializable]"; }
}
