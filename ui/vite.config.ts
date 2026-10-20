/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// La version affichée dans l'en-tête vient du package.json RACINE — la même
// valeur que `src-tauri/tauri.conf.json`, donc celle de l'installeur. Injectée
// à la compilation plutôt que lue par `getVersion()` : synchrone, sans état
// d'attente ni cas d'échec à dessiner, et identique en développement comme
// dans l'application empaquetée.
const versionApplication = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  define: {
    __VERSION_APPLICATION__: JSON.stringify(versionApplication),
  },

  /*
   * T-133 — FUSEAU FIGÉ POUR LES TESTS.
   *
   * Les runners GitHub tournent en UTC, ce poste en Europe/Paris. Un test du
   * réveil vérifie qu'une heure de mur est préservée au passage à l'heure
   * d'été (nuit du 29 mars) : en Europe l'écart réel vaut 22 h 30, en UTC il
   * vaut 23 h 30 — aucune nuit ne saute. Le test passait donc ici et cassait
   * les DEUX constructions de la release, sans que rien dans son code n'ait
   * annoncé qu'il dépendait du fuseau de la machine.
   *
   * Figer le fuseau rend la suite reproductible partout et garde au test ses
   * dents : sur un runner UTC, la transition qu'il exerce n'existe pas, donc
   * il ne prouverait plus rien — il passerait sans rien vérifier, ce qui est
   * pire qu'un échec. Europe/Paris et non UTC pour cette raison exacte : c'est
   * le fuseau où les bascules d'heure ont lieu, et l'application est
   * locale-first.
   *
   * Le code de production, lui, ne présume d'aucun fuseau : il lit toujours
   * celui du poste.
   */
  test: {
    env: { TZ: "Europe/Paris" },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
