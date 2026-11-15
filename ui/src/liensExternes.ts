/*
 * Filet global des liens web : la fenêtre d'IAction n'est JAMAIS un navigateur.
 *
 * Un `<a href="https://…">` que personne n'intercepte fait naviguer la webview
 * Tauri elle-même : la page de l'application est remplacée par le site, sans
 * barre d'adresse ni bouton « précédent » pour revenir (constat du 2026-10-26,
 * liens des sources web — SourcesWeb.tsx). Plutôt que de compter sur chaque
 * composant pour penser à intercepter son clic, un seul écouteur au niveau du
 * document route tout lien web vers le navigateur par défaut du système
 * (`open_external` sans commande → `xdg-open`).
 *
 * Un composant qui gère déjà son lien (Markdown.tsx : registre d'applications,
 * T-049) appelle `preventDefault` : l'écouteur, en phase de bouillonnement,
 * le voit et n'ouvre rien une seconde fois.
 */
import { openExternal } from "./appsAdmin";
import { logWarn } from "./journal";

/** Schémas qui appartiennent au navigateur ou au client mail, jamais à la webview. */
const SCHEMAS_EXTERNES = ["http:", "https:", "mailto:"];

/**
 * `href` doit-il partir hors de l'application ? Oui pour un lien web vers une
 * autre origine que celle de l'UI ; non pour une ancre interne, un lien
 * relatif ou l'origine de l'app (serveur de dev, `tauri://`).
 */
export function lienAOuvrirDehors(href: string, origineApp: string): boolean {
  let url: URL;
  try {
    url = new URL(href, origineApp);
  } catch {
    return false;
  }
  if (!SCHEMAS_EXTERNES.includes(url.protocol)) return false;
  return url.protocol === "mailto:" || url.origin !== origineApp;
}

function intercepter(e: MouseEvent): void {
  if (e.defaultPrevented) return;
  // Clic gauche ou clic du milieu (ouverture « nouvel onglet »), rien d'autre.
  if (e.button !== 0 && e.button !== 1) return;
  const lien = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!(lien instanceof HTMLAnchorElement)) return;
  if (!lienAOuvrirDehors(lien.href, window.location.origin)) return;
  e.preventDefault();
  openExternal(lien.href, null).catch((err: unknown) => {
    logWarn("ui", "lien web non ouvert dans le navigateur système", {
      fields: { erreur: String(err) },
    });
  });
}

/** À appeler une fois au démarrage (main.tsx). */
export function installerInterceptionLiens(): void {
  document.addEventListener("click", intercepter);
  document.addEventListener("auxclick", intercepter);
}
