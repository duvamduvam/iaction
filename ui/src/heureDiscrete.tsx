/**
 * Heure des lignes discrètes du fil (T-101).
 *
 * ── Le trou qu'il comble ─────────────────────────────────────────────────
 * Les « fonctions discrètes » (bandeau de recherche web, débord, compaction
 * d'historique, lignes d'état vocal — voir docs/tickets.md, T-101) informent
 * sans interrompre le tour, mais ne disent pas QUAND l'événement a eu lieu.
 * Relue dix minutes après, une ligne « Recherche web… » ne se rapproche ni
 * du journal (`logs/app.jsonl`, horodaté à la milliseconde) ni de la
 * chronologie du fil. Ce module ajoute cette heure, et RIEN d'autre :
 * placement et format sont tranchés par docs/maquette-heures-discretes.html,
 * pas ici.
 *
 * ── Pourquoi une fonction pure, et deux composants minces ────────────────
 * `formaterHeureDiscrete` ne connaît ni React ni le fil : elle transforme un
 * instant (epoch ms OU chaîne ISO — les deux cohabitent selon la famille, un
 * `Date.now()` côté réception, un `new Date().toISOString()` déjà posé dans
 * l'état ailleurs) en `HH:MM` local, ou en RIEN si l'instant manque — jamais
 * une heure fausse. C'est elle qui est testée. `NoticeEnTete`/`NoticeEnQueue`
 * ne sont que le câblage visuel commun aux deux pages (Chat, Projets) : le
 * même composant des deux côtés, comme la maquette l'exige pour la famille
 * du bandeau `agent-tabs__notice`.
 *
 * ── Pourquoi `suivreInstant` existe ──────────────────────────────────────
 * Le principe du ticket est de capter l'heure à la SOURCE du signal. Quand
 * elle existe (compaction : `ChatCompaction.at` ; recherche web : reçue dans
 * le callback `onWeb`), elle est câblée directement dans l'état de la page —
 * ce module n'a rien à faire de plus. Mais deux familles n'ont AUCUN
 * horodatage disponible sans sortir du périmètre de ce chantier : l'état
 * vocal (`VoiceComposer` vient de `useVoiceComposer.ts`, hors périmètre —
 * un autre chantier, T-125, y travaille EN CE MOMENT) et le débord côté
 * Projets (`ConvRuntime` y est partagé avec `modeleProjet.ts`, hors
 * périmètre lui aussi). Pour ces deux cas, l'heure retenue est celle de la
 * RÉCEPTION par le composant qui affiche la ligne — le repli explicitement
 * prévu par le ticket. `suivreInstant` capte cet instant une seule fois par
 * valeur (comparée par référence/égalité) : un re-rendu qui ne change pas la
 * valeur renvoie l'état précédent tel quel, donc l'heure affichée ne dérive
 * jamais au fil des rendus suivants — seul un signal réellement NOUVEAU la
 * fait avancer.
 */
import type { ReactNode } from "react";

/**
 * `HH:MM`, heure locale. `instant` accepte un epoch en millisecondes (le cas
 * courant, `Date.now()`) ou une chaîne ISO (le cas de `ChatCompaction.at`,
 * déjà posée ailleurs) — les deux cohabitent selon la famille de signal.
 * `null`/`undefined`/une date invalide renvoient `null` : pas d'heure plutôt
 * qu'une heure fausse.
 */
export function formaterHeureDiscrete(instant: number | string | null | undefined): string | null {
  if (instant == null) return null;
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Bandeau `agent-tabs__notice` (familles A/D) : l'heure précède le texte,
 * suivie d'un séparateur « · » — absente, ni l'heure ni le séparateur ne
 * s'affichent, jamais de point qui pende devant rien.
 */
export function NoticeEnTete({
  instant,
  children,
}: Readonly<{ instant: number | string | null; children: ReactNode }>) {
  const heure = formaterHeureDiscrete(instant);
  if (!heure) return <>{children}</>;
  return (
    <>
      <span className="heure heure--tete">{heure}</span>· {children}
    </>
  );
}

/**
 * Ligne « en queue » (familles B/C : compaction, état vocal) : deux enfants
 * directs destinés à un conteneur `.ligne-queue` (flex, `justify-content:
 * space-between`) — le texte à gauche, l'heure fixe à droite. Sans heure,
 * seul le texte est rendu (pas d'span vide à droite).
 */
export function NoticeEnQueue({
  instant,
  children,
}: Readonly<{ instant: number | string | null; children: ReactNode }>) {
  const heure = formaterHeureDiscrete(instant);
  return (
    <>
      <span>{children}</span>
      {heure && <span className="heure heure--queue">{heure}</span>}
    </>
  );
}

/** État suivi par `suivreInstant` : la dernière valeur vue, et quand. */
export interface InstantSuivi<T> {
  valeur: T;
  instant: number;
}

/**
 * Capte l'instant d'apparition d'une valeur qui n'apporte aucun horodatage
 * de source — repli du ticket pour les signaux hors périmètre (voir l'en-
 * tête du module). `valeur: null` efface le suivi (le signal a disparu) ;
 * une valeur inchangée (comparée avec `Object.is`) renvoie `precedent` sans
 * le toucher, pour que l'heure affichée ne dérive pas à chaque rendu.
 */
export function suivreInstant<T>(
  precedent: InstantSuivi<T> | null,
  valeur: T | null,
  maintenant: number,
): InstantSuivi<T> | null {
  if (valeur === null) return null;
  if (precedent && Object.is(precedent.valeur, valeur)) return precedent;
  return { valeur, instant: maintenant };
}
