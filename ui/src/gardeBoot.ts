/*
 * Garde-fou de démarrage : l'interface est peinte, mais la coquille ne répond
 * pas (T-009).
 *
 * ── Le défaut ───────────────────────────────────────────────────────────
 * Le 2026-08-08 à 11 h 36, `dev.sh` relancé : vite démarre à 11:36:53, la
 * fenêtre s'ouvre à 11:36:55 — le moteur web a chargé la page pendant la
 * ré-optimisation à froid de vite. L'interface s'est affichée, l'air parfaitement
 * saine, mais la greffe IPC n'a jamais été initialisée : `config_read` sans
 * réponse, « Aucun projet » alors que la configuration était intacte, et ZÉRO
 * trafic pendant treize minutes sans le moindre message. Un simple rechargement
 * du webview réparait tout.
 *
 * C'est le pire genre de panne : rien n'est cassé À L'ÉCRAN. L'utilisateur voit
 * une application vide et en conclut qu'elle a perdu ses données.
 *
 * ── Ce que fait cette garde, et ce qu'elle ne fait pas ──────────────────
 * Elle pose une question simple — « la coquille a-t-elle répondu, ne serait-ce
 * qu'une fois ? » — et laisse un délai large pour y répondre. Passé ce délai
 * sans une seule réponse, elle le DIT. Elle ne recharge pas d'elle-même : un
 * rechargement automatique effacerait ce que l'utilisateur était en train de
 * taper, et surtout il rendrait la panne invisible une seconde fois, ce qui
 * est exactement le travers qu'on corrige.
 *
 * Le délai part du montage de l'interface, pas du lancement du process : c'est
 * la fenêtre où la greffe IPC doit s'établir. Les relevés de T-029 donnent
 * ~1,3 s entre le script et la première image sur ce poste ; six secondes
 * laissent donc une marge de quatre fois, y compris sur une machine chargée.
 */

/** Large exprès : mieux vaut ne rien dire trop tard que crier sur une machine lente. */
export const DELAI_SILENCE_MS = 6000;

export interface GardeBoot {
  /** Une réponse est arrivée : la greffe IPC fonctionne, le minuteur s'éteint. */
  signalerVivant(): void;
  /** Démontage : n'appelle plus rien. */
  arreter(): void;
}

export interface OptionsGardeBoot {
  delaiMs?: number;
  /** Appelé UNE fois si rien n'a répondu dans le délai. */
  auSilence: () => void;
  /** Injectables pour les tests — jamais fournis en production. */
  poserMinuteur?: (fn: () => void, ms: number) => unknown;
  annulerMinuteur?: (handle: unknown) => void;
}

/**
 * Arme la garde. Le contrat tient en trois phrases : `auSilence` n'est appelé
 * qu'une fois, jamais après `signalerVivant`, et jamais après `arreter`.
 */
export function armerGardeBoot(options: OptionsGardeBoot): GardeBoot {
  const delaiMs = options.delaiMs ?? DELAI_SILENCE_MS;
  const poser = options.poserMinuteur ?? ((fn, ms) => setTimeout(fn, ms));
  const annuler = options.annulerMinuteur ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let tranche = false;
  let handle: unknown = poser(() => {
    if (tranche) return;
    tranche = true;
    options.auSilence();
  }, delaiMs);

  function eteindre() {
    if (handle !== null) {
      annuler(handle);
      handle = null;
    }
  }

  return {
    signalerVivant() {
      // `tranche` passe à true même si le minuteur a déjà parlé : une réponse
      // tardive ne doit pas déclencher un second avis, et l'interface, elle,
      // décide seule de retirer le bandeau.
      tranche = true;
      eteindre();
    },
    arreter() {
      tranche = true;
      eteindre();
    },
  };
}
