/*
 * Administration du registre d'applications externes (page « Configuration »,
 * section « Applications ») : config non-secrète (règle extension → app) via
 * `appConfig` (lecture → fusion → écriture du document complet, voir
 * appConfig.ts), clé racine "apps". Aucun secret associé — au pire une
 * commande shell, jamais une clé API.
 *
 * `id` = slug stable dérivé du libellé, même schéma que projectAdmin.ts.
 */
import { invoke } from "@tauri-apps/api/core";
import { readConfig, writeConfig } from "./appConfig";

export interface AppEntry {
  id: string;
  label: string;
  command: string;
  /** Extensions normalisées : minuscules, sans point (ex. "pdf", "kicad_pcb"). */
  extensions: string[];
}

function isAppEntry(value: unknown): value is AppEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    typeof v.command === "string" &&
    Array.isArray(v.extensions) &&
    v.extensions.every((e) => typeof e === "string")
  );
}

/**
 * Règles pré-remplies au tout premier lancement (clé "apps" absente de la
 * config). Une app absente de la machine échouera proprement à l'ouverture
 * (« application introuvable ») — la règle reste éditable/supprimable, et une
 * fois la clé écrite, les suppressions de l'utilisateur sont respectées
 * (aucun re-seed).
 */
export const DEFAULT_APPS: AppEntry[] = [
  {
    id: "kicad",
    label: "KiCad",
    command: "kicad",
    extensions: ["kicad_pro", "kicad_pcb", "kicad_sch", "kicad_sym", "kicad_mod"],
  },
  {
    id: "libreoffice",
    label: "LibreOffice",
    command: "libreoffice",
    extensions: ["odt", "ods", "odp", "doc", "docx", "xls", "xlsx", "ppt", "pptx"],
  },
  {
    id: "inkscape",
    label: "Inkscape",
    command: "inkscape",
    extensions: ["ai", "eps"],
  },
  {
    id: "vlc",
    label: "VLC",
    command: "vlc",
    extensions: ["mp4", "mkv", "avi", "webm", "mov", "mp3", "flac", "ogg", "wav"],
  },
];

/**
 * Lit la config non-secrète et renvoie la liste des règles d'apps.
 * Premier lancement (clé "apps" absente) : amorce DEFAULT_APPS et les persiste.
 * Clé présente (même tableau vide) : aucune ré-injection.
 */
export async function readApps(): Promise<AppEntry[]> {
  const raw = await readConfig();
  const apps = raw.apps;
  if (!Array.isArray(apps)) {
    await writeApps(DEFAULT_APPS);
    return DEFAULT_APPS;
  }
  return apps.filter(isAppEntry);
}

/** Écrit la liste des règles d'apps dans la config non-secrète (fusion racine, cf. appConfig.ts). */
export async function writeApps(apps: AppEntry[]): Promise<void> {
  await writeConfig({ apps });
}

function slugify(label: string): string {
  const base = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // diacritiques (accents combinants apres normalize("NFD"))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "app";
}

function uniqueId(base: string, existingIds: string[]): string {
  if (!existingIds.includes(base)) return base;
  let n = 2;
  while (existingIds.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Normalise une saisie libre (virgules/espaces) en liste d'extensions minuscules sans point. */
export function parseExtensions(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    const ext = token.trim().toLowerCase().replace(/^\.+/, "");
    if (ext && !seen.has(ext)) {
      seen.add(ext);
      out.push(ext);
    }
  }
  return out;
}

/** Ajoute une règle (id slug généré depuis le libellé) et renvoie la liste à jour. */
export async function addApp(label: string, command: string, extensions: string[]): Promise<AppEntry[]> {
  const apps = await readApps();
  const id = uniqueId(
    slugify(label),
    apps.map((a) => a.id),
  );
  const next = [...apps, { id, label, command, extensions }];
  await writeApps(next);
  return next;
}

/** Modifie une règle existante (id inchangé). */
export async function updateApp(
  id: string,
  patch: Partial<Pick<AppEntry, "label" | "command" | "extensions">>,
): Promise<AppEntry[]> {
  const apps = await readApps();
  const next = apps.map((a) => (a.id === id ? { ...a, ...patch } : a));
  await writeApps(next);
  return next;
}

/** Supprime une règle. */
export async function deleteApp(id: string): Promise<AppEntry[]> {
  const apps = await readApps();
  const next = apps.filter((a) => a.id !== id);
  await writeApps(next);
  return next;
}

/**
 * Cherche la première règle dont une extension correspond à celle de `filename`. `null` si
 * aucune règle ne matche (repli attendu côté appelant : application système / xdg-open).
 */
export function findAppForExtension(apps: AppEntry[], filename: string): AppEntry | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  return apps.find((a) => a.extensions.includes(ext)) ?? null;
}

/**
 * Ouvre `path` avec `command` (spawn détaché, environnement nettoyé de la pollution Snap
 * côté Rust — voir `open_external.rs`) ou, si absent/vide, l'application système par défaut
 * (`xdg-open` sous Linux). Seul point de contact avec la commande Tauri `open_external`.
 */
export async function openExternal(path: string, command?: string | null): Promise<void> {
  await invoke("open_external", { path, command: command?.trim() ? command.trim() : null });
}
