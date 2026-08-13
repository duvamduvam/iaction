/// <reference types="vite/client" />

/**
 * Version de l'application, injectée à la compilation depuis le package.json
 * racine (voir `define` dans ui/vite.config.ts) — même valeur que
 * `src-tauri/tauri.conf.json`, donc que l'installeur.
 */
declare const __VERSION_APPLICATION__: string;
