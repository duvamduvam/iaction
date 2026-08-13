/**
 * Runtime de conversation — le moteur partagé par le Chat et les Projets.
 *
 * ── Pourquoi ce fichier existe ──────────────────────────────────────────
 * `AgentPage` et `ChatPage` tenaient chacune sa propre copie de ce mécanisme.
 * Le relevé du 2026-08-08 a trouvé 106 identifiants portant le même nom dans
 * les deux fichiers ; les quatre fonctions du runtime y étaient
 * structurellement identiques, ne différant que par la charge utile
 * (`turns: AgentTurn[]` d'un côté, `entries: ChatEntry[]` de l'autre).
 *
 * Ce n'est pas une remarque esthétique : **le même défaut y a été corrigé deux
 * fois** — la jauge de contexte figée à zéro après une compaction. Un moteur
 * unique ferme cette classe entière de défauts, parce qu'il n'y a plus deux
 * endroits où l'oubli est possible.
 *
 * ── Le point délicat : qui déclenche un rendu ───────────────────────────
 * La donnée vit dans une `Map` en `ref`, PAS dans un `useState`. Les callbacks
 * de streaming capturent l'identifiant de conversation par fermeture : elles
 * écrivent donc toujours dans la bonne conversation, quel que soit l'onglet
 * affiché quand le fragment arrive. Un `useState` imposerait de recréer la Map
 * entière à chaque delta.
 *
 * Le compteur `tick` est le seul bout d'état React du mécanisme. Il force un
 * nouveau rendu pour que le point « ● » d'un onglet en arrière-plan et le
 * contenu de la conversation active restent à jour.
 *
 * D'où une distinction que cette interface rend EXPLICITE, là où elle était
 * jusqu'ici implicite dans le choix entre `updateRuntime(…)` et un
 * `runtimesRef.current.set(…)` écrit à la main :
 *
 *   - `ecrire()`  incrémente le tick — pour tout ce qui doit s'afficher ;
 *   - `poser()`   ne l'incrémente PAS — pour la frappe au clavier, où un rendu
 *                 par caractère coûterait cher et n'apporterait rien, le champ
 *                 de saisie étant déjà à jour tout seul.
 *
 * Se tromper de méthode est le piège de ce module. C'est pourquoi les deux
 * portent des noms différents plutôt qu'un drapeau booléen, et pourquoi les
 * tests vérifient le comportement du tick pour chacune.
 *
 * ── T-031 : le rendu par FRAGMENT reçu ──────────────────────────────────
 * `poser()` avait réglé le coût de la frappe, mais pas celui du streaming :
 * un fragment de réponse arrive comme un événement Tauri à part, donc
 * `ecrire()` demandait un rendu complet de la page PAR FRAGMENT — trente à
 * cent fois par seconde selon le fournisseur. À chaque fois : toute la
 * transcription reparcourue, le Markdown de la bulle en cours reparsé en
 * entier (coût qui croît avec la réponse), et le recollage en bas qui force
 * une remise en page du fil. D'où une réponse qui s'écrit par à-coups — et
 * une frappe qui redevient poussive dès qu'on tape pendant qu'un tour répond.
 *
 * Le remède est une CADENCE (voir `creerRythme`), pas une file de fragments :
 * la donnée reste écrite immédiatement et intégralement — qui la lit la lit
 * juste — seul l'AFFICHAGE est ramené à ~12 images par seconde, ce que l'œil
 * lit comme du texte qui coule. Front montant : une écriture isolée (clic,
 * changement d'onglet) s'affiche sans le moindre délai ; seules les rafales
 * sont regroupées.
 */

import { useEffect, useRef, useState } from "react";

export interface Depot<R> {
  /** Runtime vif d'une conversation — créé vierge à la volée s'il est absent. */
  lire(convId: string): R;
  /** Runtime s'il existe déjà, sans jamais en créer un. Pour les tests d'état (« est-elle en streaming ? »). */
  consulter(convId: string): R | undefined;
  /** Vrai si la conversation a déjà un runtime vivant. */
  connait(convId: string): boolean;
  /**
   * Amorce le runtime depuis la dernière copie connue SI la conversation n'a
   * jamais été ouverte pendant cette exécution. Ne touche JAMAIS un runtime
   * déjà vivant : une conversation en cours de streaming ne doit pas être
   * réinitialisée par la réouverture de son onglet.
   */
  amorcer(convId: string, creer: () => R): void;
  /** Écrit et demande un nouveau rendu. Le cas courant. */
  ecrire(convId: string, majeur: (prev: R) => R): void;
  /** Écrit SANS nouveau rendu — réservé à la frappe au clavier (voir l'en-tête). */
  poser(convId: string, valeur: R): void;
  /** Oublie une conversation fermée. */
  oublier(convId: string): void;
  /** Parcours de toutes les conversations vivantes. */
  entrees(): IterableIterator<[string, R]>;
  /** Repart d'une Map neuve — changement de projet, ou élagage en bloc. */
  reinitialiser(depart?: Map<string, R>): void;
}

/** Une écriture au plus tous les ~80 ms à l'affichage : ~12 images/s, lues comme du texte qui coule. */
export const CADENCE_RENDU_MS = 80;

/**
 * Régulateur de rendu à FRONT MONTANT (voir l'en-tête, T-031).
 *
 * Isolé de React et du dépôt pour être vérifiable avec un simple compteur et
 * des minuteurs simulés : c'est la seule pièce du module qui a une notion de
 * temps, et c'est celle dont un défaut se verrait le moins (une réponse « un
 * peu saccadée » ne casse aucun test de comportement).
 */
export interface Rythme {
  /** Demande un rendu : tout de suite si la fenêtre est libre, sinon à sa fin — un seul, jamais une file. */
  demander(): void;
  /** Oublie le rendu en attente — démontage : rien ne doit tirer sur une page morte. */
  arreter(): void;
}

export function creerRythme(rendre: () => void, intervalleMs: number = CADENCE_RENDU_MS): Rythme {
  /** Date du dernier rendu ; `-Infinity` = jamais rendu, donc fenêtre libre. */
  let dernierMs = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function rendreMaintenant() {
    dernierMs = Date.now();
    rendre();
  }

  return {
    demander() {
      // Un rendu est déjà programmé : il affichera l'état le plus récent, y
      // compris ce qui vient d'être écrit. En reprogrammer un deuxième
      // n'ajouterait qu'une image identique.
      if (timer !== null) return;
      const reste = intervalleMs - (Date.now() - dernierMs);
      if (reste <= 0) {
        rendreMaintenant();
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        rendreMaintenant();
      }, reste);
    },
    arreter() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Le dépôt lui-même, sans React.
 *
 * Séparé du hook pour une raison très concrète : l'interface n'a pas de
 * bibliothèque de rendu pour les tests, et en ajouter une pour vérifier une
 * Map serait payer cher un besoin qui n'existe pas. En sortant la logique de
 * React, elle se teste avec un simple compteur d'appels — et le hook qui reste
 * ne fait plus qu'une chose : relier `prevenir` à un `setState`.
 *
 * `prevenir` est appelé uniquement par `ecrire()`. C'est toute la distinction
 * décrite en tête de fichier. Le dépôt ignore la cadence : c'est le hook qui
 * lui passe un `prevenir` cadencé (T-031), et le dépôt nu — celui des tests —
 * garde donc l'équivalence « une écriture = un avis ».
 */
export function creerDepot<R>(vierge: () => R, prevenir: () => void): Depot<R> {
  let runtimes = new Map<string, R>();

  function lire(convId: string): R {
    let r = runtimes.get(convId);
    if (!r) {
      r = vierge();
      runtimes.set(convId, r);
    }
    return r;
  }

  return {
    lire,
    consulter: (convId) => runtimes.get(convId),
    connait: (convId) => runtimes.has(convId),
    amorcer(convId, creer) {
      if (!runtimes.has(convId)) runtimes.set(convId, creer());
    },
    ecrire(convId, majeur) {
      // La donnée d'abord, et en entier : elle doit être juste pour qui la lit
      // (envoi, persistance, abandon) même si son affichage attend la cadence.
      runtimes.set(convId, majeur(lire(convId)));
      prevenir();
    },
    poser(convId, valeur) {
      runtimes.set(convId, valeur);
    },
    oublier(convId) {
      runtimes.delete(convId);
    },
    entrees: () => runtimes.entries(),
    reinitialiser(depart) {
      runtimes = depart ?? new Map();
    },
  };
}

export interface RuntimeConversation<R> {
  depot: Depot<R>;
  /**
   * Avance après une écriture — à mettre dans les dépendances d'un effet qui
   * suit le streaming. Pas un compteur d'écritures : une rafale de fragments
   * ne le fait avancer qu'une fois par fenêtre de cadence (T-031). Aucune
   * écriture n'est perdue pour autant, le rendu de rattrapage affichant
   * toujours l'état le plus récent — seul son instant est borné à ~80 ms.
   */
  tick: number;
}

export function useConversationRuntime<R>(vierge: () => R): RuntimeConversation<R> {
  const [tick, setTick] = useState(0);
  // Créés UNE fois : le dépôt et son rythme survivent aux rendus, comme la
  // `ref` qu'ils remplacent.
  const depot = useRef<Depot<R> | null>(null);
  const rythme = useRef<Rythme | null>(null);
  if (depot.current === null) {
    const cadence = creerRythme(() => setTick((t) => t + 1));
    rythme.current = cadence;
    depot.current = creerDepot(vierge, () => cadence.demander());
  }
  // Un rendu encore programmé au démontage ne doit pas tirer sur une page morte.
  useEffect(() => () => rythme.current?.arreter(), []);
  return { depot: depot.current, tick };
}
