/*
 * Battement du réveil (docs/spec-reveil.md §5/§6) — le hook que ChatPage et
 * AgentPage appellent en UNE ligne chacune.
 *
 * ── Pourquoi un hook et pas deux effets jumeaux ─────────────────────────
 * Écrit d'abord en double, un effet par page, à l'image des autres jumeaux de
 * ces deux fichiers. C'était une erreur, et l'en-tête de
 * `useConversationRuntime.ts` dit laquelle : ce sont deux copies d'un même
 * mécanisme, donc deux endroits où le prochain défaut devra être corrigé —
 * « le même défaut y a été corrigé deux fois » y est raconté au passé, il n'y
 * avait pas de raison de le réécrire au futur. Le cliquet de taille l'a
 * signalé au même moment, et pour la même raison de fond.
 *
 * La décision temporelle reste dans `reveil.ts` (pure, sans horloge), le
 * versement dans `reveilRuntime.ts` (pur, sans React). Ce fichier n'ajoute
 * que ce qui EXIGE React : la minuterie et son nettoyage.
 *
 * ── Ce que ce hook ne fait toujours pas ─────────────────────────────────
 * Aucun envoi (§2). Il verse dans `queuedPrompts` et c'est l'effet de
 * drainage de chaque page qui appelle `handleSend`. Aucune sonde de quota
 * n'est ajoutée non plus : chaque réveil porte sa propre cible de réouverture,
 * figée à l'armement (voir reveil.ts) — le battement n'interroge donc RIEN,
 * il ne fait que comparer des dates.
 */
import { useEffect, useRef } from "react";
import { logInfo, logWarn } from "./journal";
import { battreReveils, BATTEMENT_REVEIL_MS, libelleEvenementReveil, type RuntimeAvecReveil } from "./reveilRuntime";
import type { Depot } from "./useConversationRuntime";

/**
 * Arme la minuterie qui balaie TOUTES les conversations du dépôt — pas
 * seulement l'active : un réveil posé sur un onglet d'arrière-plan doit
 * partir, c'est même le cas d'usage normal (on arme, on va ailleurs).
 *
 * ── `activer`, et pourquoi il est indispensable ─────────────────────────
 * Verser dans `queuedPrompts` NE SUFFIT PAS à faire partir un tour : l'effet
 * de drainage de chaque page ne draine que la conversation ACTIVE, parce que
 * `handleSend` fige sa cible sur elle et lit les réglages du composeur de la
 * page (modèle, agent, permissions) — limite assumée de longue date, écrite
 * dans le commentaire de cet effet. Sans bascule, un réveil de 3 h sur un
 * onglet d'arrière-plan resterait donc « En file » jusqu'au retour de
 * l'utilisateur : exactement la promesse que la fonctionnalité existe pour
 * tenir, et qu'elle ne tiendrait pas.
 *
 * D'où `activer` : à l'échéance, la page rend la conversation concernée
 * active, et le drainage existant fait le reste. UNE SEULE bascule par
 * battement — si deux réveils tombent ensemble, le second reste en file et
 * partira à son tour quand on ira le voir : basculer deux fois ne voudrait
 * rien dire, et le journal garde la trace des deux.
 *
 * Le dépôt vit dans une `ref` (voir `useConversationRuntime.ts`) : il ne
 * change jamais d'identité, d'où une minuterie montée UNE fois pour la vie du
 * composant. `activer`, lui, se referme sur l'état de la page et change à
 * chaque rendu : il passe donc par une ref tenue à jour, jamais capturé dans
 * la fermeture de la minuterie (ce serait la version du premier rendu).
 *
 * @param activer Rend une conversation active. À charge de l'appelant de ne
 *   rien faire si elle l'est déjà — la bascule est un geste coûteux et visible.
 */
export function useBattementReveil<R extends RuntimeAvecReveil>(
  depot: Depot<R>,
  activer: (convId: string) => void,
): void {
  const activerRef = useRef(activer);
  useEffect(() => {
    activerRef.current = activer;
  });

  useEffect(() => {
    const id = setInterval(() => {
      const maintenant = Date.now();
      const evenements = battreReveils(depot, maintenant);
      let basculeFaite = false;
      for (const evt of evenements) {
        const label = libelleEvenementReveil(evt);
        // Action discrète posée dans le fil de LA conversation concernée
        // (§6), même registre que `debordNotice`/`avancementWeb` — écrite
        // même en arrière-plan, c'est tout l'intérêt du badge « ● ».
        depot.ecrire(evt.convId, (r) => ({ ...r, reveilNotice: { label, at: new Date(maintenant).toISOString() } }));
        // Canal dédié (§6) : un réveil ABANDONNÉ se journalise aussi, en
        // `warn` — sans quoi il serait très exactement l'échec muet que la
        // doctrine d'observabilité interdit.
        if (evt.type === "declenche") logInfo("reveil", label, { fields: { convId: evt.convId } });
        else logWarn("reveil", label, { fields: { convId: evt.convId } });

        // Bascule (voir l'en-tête) : seulement pour un réveil qui a VRAIMENT
        // quelque chose à envoyer — un abandon n'a rien versé, et voler
        // l'onglet actif pour annoncer qu'il ne se passe rien serait pire que
        // le silence.
        if (evt.type === "declenche" && !basculeFaite) {
          basculeFaite = true;
          activerRef.current(evt.convId);
        }
      }
    }, BATTEMENT_REVEIL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
