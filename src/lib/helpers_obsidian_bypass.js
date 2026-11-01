import { DebugLogManager } from "./utils/debug_log_manager";
import { formatDiagnostic } from "./utils/redact_log";

export let logLevel = "internal";

export const setLogEnabled = (level) => {
  logLevel = level;
};

export const dump = function (...message) {
  if (logLevel === "console") {
    console.log(...message.map(formatDiagnostic));
  } else if (logLevel === "internal") {
    DebugLogManager.getInstance().addLog(...message);
  }
};

export const dumpError = function (...message) {
  if (logLevel === "console") {
    console.error(...message.map(formatDiagnostic));
  } else if (logLevel === "internal") {
    DebugLogManager.getInstance().addLog("[ERROR]", ...message);
  }
};

export async function nativeFetch(input, init) {
  return await fetch(input, init);
}

export async function vaultDelete(vault, file, force) {
  return await vault.delete(file, force);
}
