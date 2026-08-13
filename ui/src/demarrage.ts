/*
 * Jalons de démarrage côté interface — la moitié de la mesure que le Rust ne
 * peut pas faire.
 *
 * La coquille sait quand elle a construit la fenêtre ; elle ne sait pas quand
 * le moteur web a fini de charger les 7 Mo de JS que sert Vite en
 * développement, ni quand React a dessiné quelque chose. Or c'est précisément
 * là que se joue l'attente perçue : entre une fenêtre qui existe et une
 * fenêtre qui montre l'application. Deux jalons, donc, envoyés à la commande
 * `demarrage_jalon` qui les écrit dans `logs/coquille.jsonl` (voir
 * `src-tauri/src/demarrage.rs` et `docs/protocol.md`, § « Jalons de
 * démarrage ») :
 *
 * - `ui:script` — le module d'entrée s'exécute : webview prête, JS chargé ;
 * - `ui:premier-rendu` — la première image a été peinte.
 *
 * Chaque jalon porte AUSSI `pageMs` — l'horloge de la page (`performance.now()`,
 * origine = début de la navigation). C'est ce qui partage le segment en deux :
 * ce que coûte le moteur web AVANT que la page n'existe (démarrage du
 * `WebKitWebProcess`, rendu logiciel forcé) et ce que coûte le chargement de
 * l'interface elle-même. Sans lui, un gros chiffre ne désigne aucun coupable.
 *
 * L'envoi est injectable pour que la logique (chaque jalon une seule fois,
 * jamais d'exception vers l'appelant) se teste sans Tauri.
 */
import { invoke } from "@tauri-apps/api/core";

/** Vocabulaire fermé, identique à celui qu'accepte le Rust. */
export type JalonUi = "ui:script" | "ui:premier-rendu";

/**
 * Un jalon ne vaut que pour LE démarrage : posé deux fois, le second chiffre
 * ne mesure plus rien (double montage du `StrictMode`, rechargement à chaud).
 * Le Rust dédoublonne déjà de son côté — on ne lui envoie pas de bruit pour
 * autant, sans quoi une erreur y serait invisible ici.
 */
export function creerJalonneur(
  envoi: (etape: JalonUi, pageMs: number) => void,
  horloge: () => number = () => performance.now(),
): (etape: JalonUi) => void {
  const poses = new Set<JalonUi>();
  return (etape) => {
    if (poses.has(etape)) return;
    poses.add(etape);
    // Une mesure ne casse jamais ce qu'elle mesure : hors Tauri (tests, build
    // web) `invoke` rejette, et ça s'arrête là.
    try {
      envoi(etape, Math.round(horloge()));
    } catch {
      /* best effort */
    }
  };
}

const poser = creerJalonneur((etape, pageMs) => {
  void invoke("demarrage_jalon", { etape, pageMs }).catch(() => {
    /* best effort : jamais d'erreur remontée pour un jalon */
  });
});

/** Le module d'entrée s'exécute : la webview a chargé et parsé l'interface. */
export function jalonScript(): void {
  poser("ui:script");
}

/**
 * Premier rendu effectif. Deux `requestAnimationFrame` imbriqués : le premier
 * s'exécute AVANT la peinture de la frame courante, le second au début de la
 * suivante — donc une fois l'image réellement affichée. Un `setTimeout(0)`
 * mesurerait la fin du travail de React, pas le moment où l'utilisateur voit
 * enfin quelque chose.
 */
export function jalonPremierRendu(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => poser("ui:premier-rendu"));
  });
}
