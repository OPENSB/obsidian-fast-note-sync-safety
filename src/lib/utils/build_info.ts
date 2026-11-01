declare const __FNS_BUILD_VERSION__: string;
declare const __FNS_BUILD_ID__: string;

/** Compiled into main.js, independent of BRAT settings or a copied manifest.json. */
export const RUNTIME_VERSION = __FNS_BUILD_VERSION__;
export const RUNTIME_BUILD_ID = __FNS_BUILD_ID__;
