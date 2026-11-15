/**
 * T-214 — copie de texte dans le presse-papier, commune aux trois boutons
 * « Copier » (blocs de code, page Système, menu des références).
 *
 * Sous WebKitGTK (Tauri Linux), `navigator.clipboard.writeText` est souvent
 * refusé au PREMIER clic quand la fenêtre revient d'une autre application
 * (hypothèse : le document n'a pas encore le focus). Le second clic passe.
 * D'où deux replis, dans l'ordre :
 *   1. `document.execCommand("copy")` sur une zone de texte temporaire : la
 *      vieille voie, synchrone, qui ne passe pas par l'API asynchrone refusée ;
 *   2. attendre que la fenêtre ait le focus (400 ms au plus), puis réessayer
 *      `writeText`.
 * Le repli natif Rust (arboard) attend que l'app soit fermée (modifier
 * src-tauri la relance en `tauri dev`) : il ne vient que si ces deux-là ne
 * suffisent pas.
 *
 * Jamais d'échec muet : tout refus de `writeText` est journalisé avec son
 * nom, son message et l'état du focus, puis l'issue (repli qui a marché, ou
 * échec final). C'est ce journal qui confirmera ou non l'hypothèse du focus.
 */
import { logInfo, logWarn } from "./journal";

const ATTENTE_FOCUS_MS = 400;

function decrire(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** Vieille voie synchrone : zone de texte hors écran, sélection, `copy`. */
function copierParExecCommand(texte: string): boolean {
  const actif = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const zone = document.createElement("textarea");
  zone.value = texte;
  zone.setAttribute("readonly", "");
  zone.style.position = "fixed";
  zone.style.top = "-1000px";
  zone.style.opacity = "0";
  document.body.appendChild(zone);
  try {
    zone.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    zone.remove();
    actif?.focus();
  }
}

function attendreFocus(): Promise<void> {
  if (document.hasFocus()) return Promise.resolve();
  return new Promise((resolve) => {
    const fin = () => {
      clearTimeout(minuteur);
      window.removeEventListener("focus", fin);
      resolve();
    };
    const minuteur = setTimeout(fin, ATTENTE_FOCUS_MS);
    window.addEventListener("focus", fin);
  });
}

/** Copie `texte` ; `true` si le presse-papier l'a reçu, par une voie ou une autre. */
export async function copierTexte(texte: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(texte);
    return true;
  } catch (err) {
    const focusAuRefus = document.hasFocus();
    const erreur = decrire(err);
    if (copierParExecCommand(texte)) {
      logInfo("ui", "copie : writeText refusé, repli execCommand réussi", {
        fields: { erreur, focus: focusAuRefus, longueur: texte.length },
      });
      return true;
    }
    await attendreFocus();
    try {
      await navigator.clipboard.writeText(texte);
      logInfo("ui", "copie : writeText refusé, réussi au second essai", {
        fields: { erreur, focus: focusAuRefus, focusApres: document.hasFocus(), longueur: texte.length },
      });
      return true;
    } catch (err2) {
      logWarn("ui", "copie : presse-papier refusé (writeText, execCommand, second essai)", {
        fields: { erreur, erreur2: decrire(err2), focus: focusAuRefus, focusApres: document.hasFocus(), longueur: texte.length },
      });
      return false;
    }
  }
}
