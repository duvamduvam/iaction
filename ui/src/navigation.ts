/*
 * Les sept pages de l'application, et rien d'autre.
 *
 * Ce module existe pour que la navigation au clavier (focusZones.ts) connaisse
 * les pages sans dépendre du composant racine — un import circulaire pour un
 * type et une table de sept entrées aurait été un couplage payé cher.
 */

export type PageId = "projects" | "chat" | "orchestration" | "supervision" | "config" | "system" | "sessions";

export const NAV_ITEMS: { id: PageId; label: string }[] = [
  { id: "projects", label: "Projets" },
  { id: "chat", label: "Chat" },
  { id: "orchestration", label: "Orchestration" },
  { id: "supervision", label: "Supervision" },
  { id: "config", label: "Configuration" },
  { id: "system", label: "Système" },
  { id: "sessions", label: "Sessions Claude" },
];
