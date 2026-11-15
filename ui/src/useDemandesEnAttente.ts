/*
 * Branchement React de la file des demandes en attente (T-181) : l'état, la
 * réponse à une demande, la mise de côté et la réouverture depuis le panneau
 * latéral. La logique de décision est dans demandesEnAttente.ts (pure,
 * testée) ; ce hook ne fait que la brancher à la page Agent.
 */

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  cleDemande,
  demandeCourante,
  lignesEnAttente,
  nombreAutresDuProjet,
  sansDemandesDuProjet,
  type LigneAttente,
} from "./demandesEnAttente";
import { cleAutoAllow } from "./permissions";
import type { PermissionRequestItem } from "./questionsAgent";
import { claudePermission, neutralPermission } from "./sidecar";

interface Parametres {
  projetCourantId: string | null;
  projets: ReadonlyArray<{ id: string; name: string }>;
  /** Conversations du projet affiché. */
  sessionsCourantes: ReadonlyArray<{ id: string; title: string }>;
  /** Conversations mémorisées d'un autre projet (titre affiché dans la liste), si connues. */
  sessionsDe: (projectId: string) => ReadonlyArray<{ id: string; title: string }> | undefined;
  conversationActiveId: string;
  autoAllowToolsRef: MutableRefObject<Set<string>>;
  selectProject: (id: string) => Promise<boolean>;
  selectSession: (id: string) => void;
  /** Avis visible (jamais d'échec muet). */
  avertir: (message: string) => void;
}

export function useDemandesEnAttente(params: Parametres) {
  const [file, setFile] = useState<PermissionRequestItem[]>([]);
  const [clesDeCote, setClesDeCote] = useState<string[]>([]);
  const [cleFocale, setCleFocale] = useState<string | null>(null);
  const [cible, setCible] = useState<{ projectId: string | null; convId: string | null } | null>(null);
  // Dernières valeurs : les fonctions de la page sont recréées à chaque rendu.
  const p = useRef(params);
  p.current = params;
  const { projetCourantId, sessionsCourantes, conversationActiveId } = params;

  // Bascule en deux temps : le projet change d'abord (rendu), puis la conversation.
  useEffect(() => {
    if (!cible || cible.projectId !== projetCourantId) return;
    setCible(null);
    if (!cible.convId || cible.convId === conversationActiveId) return;
    if (sessionsCourantes.some((s) => s.id === cible.convId)) p.current.selectSession(cible.convId);
    else p.current.avertir("La conversation de cette demande n'existe plus : la demande reste dans « En attente de vous ».");
  }, [cible, projetCourantId, sessionsCourantes, conversationActiveId]);

  const courante = demandeCourante(file, projetCourantId, clesDeCote, cleFocale);
  const lignes: LigneAttente[] = lignesEnAttente(
    file,
    (id) => p.current.projets.find((x) => x.id === id)?.name ?? null,
    (projectId, convId) => {
      const liste = projectId === projetCourantId ? sessionsCourantes : p.current.sessionsDe(projectId ?? "");
      return liste?.find((s) => s.id === convId)?.title ?? null;
    },
  );

  /** Répond à la demande courante ; « ne plus demander » vaut pour les demandes du MÊME projet. */
  async function decider(decision: "allow" | "deny", message: string, rememberTool: boolean) {
    if (!courante) return;
    const current = courante.item;
    const repondre = (item: PermissionRequestItem, dec: "allow" | "deny", msg?: string) =>
      item.engine === "neutral"
        ? neutralPermission(item.targetId, item.permissionId, dec, msg)
        : claudePermission(item.targetId, item.permissionId, dec, msg);
    const memes = (item: PermissionRequestItem) =>
      (item.projectId ?? null) === (current.projectId ?? null) && item.toolName === current.toolName;
    const lot = decision === "allow" && rememberTool ? file.filter((i) => cleDemande(i) !== cleDemande(current) && memes(i)) : [];
    if (decision === "allow" && rememberTool) {
      // Clé PAR PROJET du tour (voir permissions.ts).
      p.current.autoAllowToolsRef.current.add(cleAutoAllow(current.projectId ?? null, current.toolName));
    }
    for (const item of lot) {
      void repondre(item, "allow").catch((e) => p.current.avertir(`Réponse à « ${item.toolName} » non transmise : ${String(e)}`));
    }
    try {
      await repondre(current, decision, message || undefined);
    } catch (e) {
      // Le tour est probablement déjà terminé : la demande sort de la file, mais l'échec se dit.
      p.current.avertir(`Réponse non transmise à l'agent (tour terminé ?) : ${e instanceof Error ? e.message : String(e)}`);
    }
    const sorties = new Set([cleDemande(current), ...lot.map(cleDemande)]);
    setFile((prev) => prev.filter((i) => !sorties.has(cleDemande(i))));
    setCleFocale(null);
  }

  function mettreDeCote() {
    if (!courante) return;
    const cle = cleDemande(courante.item);
    setClesDeCote((prev) => (prev.includes(cle) ? prev : [...prev, cle]));
    setCleFocale(null);
  }

  /** Clic dans « En attente de vous » : bon projet, bonne conversation, modale rouverte. */
  async function ouvrir(item: PermissionRequestItem) {
    const cle = cleDemande(item);
    setClesDeCote((prev) => prev.filter((c) => c !== cle));
    setCleFocale(cle);
    const projectId = item.projectId ?? null;
    if (projectId !== projetCourantId) {
      const ok = projectId !== null && (await p.current.selectProject(projectId));
      if (!ok) {
        p.current.avertir("Changement de projet impossible pour l'instant (tour en cours ici, ou projet ouvert dans une autre fenêtre).");
        return;
      }
    }
    setCible({ projectId, convId: item.convId ?? null });
  }

  return {
    setFile,
    courante: courante ? { ...courante, autres: nombreAutresDuProjet(file, projetCourantId, courante.item) } : null,
    lignes,
    decider,
    mettreDeCote,
    ouvrir,
    retirerDuProjet: (id: string | null) => setFile((prev) => sansDemandesDuProjet(prev, id)),
  };
}
