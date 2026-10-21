/*
 * Page « Sessions Claude » (T-159, docs/spec-sessions-claude.md).
 *
 * Liste les sessions Claude Code OUVERTES SUR CE POSTE (`claude agents --json`,
 * lancé par le sidecar), permet d'en reprendre une dans IAction EN COPIE, et
 * renvoie vers claude.ai/code pour celles des autres machines — IAction ne
 * réimplémente pas Remote Control, le SDK n'en expose rien.
 *
 * Aucun échec muet : la raison d'un échec de liste ou de copie s'affiche dans
 * le panneau (le sidecar l'a déjà portée au journal) ; une impossibilité de
 * copier dans le presse-papier, de son côté, part au journal de l'interface.
 */
import { useCallback, useEffect, useState } from "react";

import { logUi } from "./journal";
import type { ProjectConfig } from "./projectAdmin";
import { ouvrirLienExterne } from "./refFichier";
import { messageReprise, type RaisonReprise } from "./repriseSession";
import {
  commandeReprise,
  heureAbsolue,
  heureRelative,
  libelleEtat,
  libelleProjet,
  libelleType,
  projetPourCwd,
  titreSession,
  URL_SESSIONS_AUTRES_MACHINES,
  type SessionClaude,
} from "./sessionsClaude";
import { claudeAgents, claudeForkSession } from "./sessionsClaudeClient";
import "./SessionsClaudePage.css";

/** Reprise acceptée = `"ok"` (l'appelant a changé de page) ; sinon la raison du refus, que ce panneau affiche. */
export type ReprendreSession = (projet: ProjectConfig, sessionIdCopie: string, titre: string) => Promise<RaisonReprise>;

function messageErreur(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SessionsClaudePage({
  projects,
  onReprendre,
}: Readonly<{ projects: ProjectConfig[]; onReprendre: ReprendreSession }>) {
  const [sessions, setSessions] = useState<SessionClaude[] | null>(null);
  const [toutes, setToutes] = useState(false);
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [enCopie, setEnCopie] = useState<string | null>(null);

  const rafraichir = useCallback(async () => {
    setChargement(true);
    setErreur(null);
    try {
      setSessions(await claudeAgents(toutes));
    } catch (err) {
      setSessions(null);
      setErreur(`Liste des sessions impossible : ${messageErreur(err)}`);
    } finally {
      setChargement(false);
    }
  }, [toutes]);

  // Chargement à l'ouverture, puis à chaque changement de l'option « terminées ».
  useEffect(() => {
    void rafraichir();
  }, [rafraichir]);

  async function copier(texte: string, quoi: string) {
    try {
      await navigator.clipboard.writeText(texte);
      setInfo(`${quoi} copié.`);
      setErreur(null);
    } catch (err) {
      logUi("warn", "ui", `copie dans le presse-papier impossible (${quoi})`, { fields: { cause: messageErreur(err) } });
      setErreur(`Copie impossible : presse-papier inaccessible (${quoi}).`);
    }
  }

  async function reprendre(session: SessionClaude, projet: ProjectConfig) {
    setEnCopie(session.sessionId);
    setErreur(null);
    setInfo(null);
    try {
      const copie = await claudeForkSession(session.sessionId, projet.path);
      const titre = `Reprise — ${titreSession(session)}`;
      const raison = await onReprendre(projet, copie, titre);
      const message = messageReprise(raison);
      if (message) {
        logUi("warn", "ui", "reprise d'une session Claude refusée", {
          fields: { sessionId: session.sessionId, projet: projet.id, raison },
        });
        setErreur(message);
      }
    } catch (err) {
      logUi("error", "ui", "reprise d'une session Claude en échec", {
        fields: { sessionId: session.sessionId, cause: messageErreur(err) },
      });
      setErreur(`Reprise impossible : ${messageErreur(err)}`);
    } finally {
      setEnCopie(null);
    }
  }

  function ouvrirAutresMachines() {
    ouvrirLienExterne(URL_SESSIONS_AUTRES_MACHINES).catch((err: unknown) => {
      logUi("error", "ui", "ouverture de claude.ai/code impossible", { fields: { cause: messageErreur(err) } });
      setErreur(`Ouverture de ${URL_SESSIONS_AUTRES_MACHINES} impossible : ${messageErreur(err)}`);
    });
  }

  return (
    <div className="sessions-claude">
      <section className="panel">
        <h2 className="panel__title">Sessions Claude</h2>
        <p className="empty-hint">
          Les sessions Claude Code ouvertes sur ce poste. « Reprendre dans IAction » en ouvre une COPIE dans une nouvelle
          conversation : la session d'origine, qui peut être vivante, n'est jamais modifiée.
        </p>
        <div className="actions">
          <button className="btn" onClick={() => void rafraichir()} disabled={chargement}>
            {chargement ? "Chargement…" : "Rafraîchir"}
          </button>
          <label className="sessions-claude__option">
            <input type="checkbox" checked={toutes} onChange={(e) => setToutes(e.target.checked)} />
            Inclure les terminées
          </label>
          <button className="btn" onClick={ouvrirAutresMachines}>
            Sessions des autres machines
          </button>
        </div>
        <p className="empty-hint">
          Pour piloter une session d'une autre machine : lancer <code>/remote-control</code> dans la session à piloter,
          puis la retrouver sur claude.ai/code.
        </p>
      </section>

      {erreur && (
        <div className="sessions-claude__erreur" role="alert">
          {erreur}
        </div>
      )}
      {info && !erreur && <div className="result-line">{info}</div>}

      {sessions !== null && sessions.length === 0 && !erreur && (
        <p className="empty-hint">Aucune session{toutes ? "" : " active"} sur ce poste.</p>
      )}

      {sessions !== null && sessions.length > 0 && (
        <table className="sessions-claude__table">
          <thead>
            <tr>
              <th>Nom</th>
              <th>Projet</th>
              <th>Type</th>
              <th>État</th>
              <th>Démarrage</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => {
              const projet = projetPourCwd(s.cwd, projects);
              return (
                <tr key={s.sessionId}>
                  <td title={s.sessionId}>{titreSession(s)}</td>
                  <td title={s.cwd ?? "dossier inconnu"}>{libelleProjet(s.cwd)}</td>
                  <td>{libelleType(s.kind)}</td>
                  <td>{libelleEtat(s.status)}</td>
                  <td title={heureAbsolue(s.startedAt)}>{heureRelative(s.startedAt)}</td>
                  <td className="sessions-claude__actions">
                    <button
                      className="btn"
                      disabled={projet === null || enCopie !== null}
                      title={
                        projet === null
                          ? "Ce dossier ne correspond à aucun projet d'IAction : ajoutez-le dans Configuration, ou copiez la commande."
                          : "Ouvre une copie de la session dans une nouvelle conversation (l'originale n'est pas modifiée)"
                      }
                      onClick={() => projet && void reprendre(s, projet)}
                    >
                      {enCopie === s.sessionId ? "Copie…" : "Reprendre dans IAction"}
                    </button>
                    {projet === null && (
                      <button className="btn btn--ghost" onClick={() => void copier(commandeReprise(s), "Commande")}>
                        Copier la commande
                      </button>
                    )}
                    <button className="btn btn--ghost" onClick={() => void copier(s.sessionId, "Identifiant")}>
                      Copier l'identifiant
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
