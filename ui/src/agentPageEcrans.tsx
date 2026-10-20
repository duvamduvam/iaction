/*
 * Fragments d'affichage autonomes de la page Projets, extraits d'AgentPage.tsx
 * (cliquet de taille) : écran « aucun projet », pastilles du projet, bandeaux
 * sous la barre d'onglets. Purement présentatifs — l'état reste dans la page.
 */
import { libelleDebordNotice, type DebordNotice } from "./debordNotice";
import { NoticeEnTete } from "./heureDiscrete";

/** Écran d'accueil quand aucun projet n'est déclaré (voir le commentaire du `return` dans AgentPage). */
export function EcranSansProjet({ onGoToConfig }: Readonly<{ onGoToConfig: () => void }>) {
  return (
    <div className="page agent-page agent-page--empty">
      <div className="agent-empty-state">
        <h1 className="page__title">Projets</h1>
        <p className="empty-hint">Déclarez votre premier projet dans Configuration pour commencer.</p>
        <button type="button" className="btn" onClick={onGoToConfig}>
          Aller à Configuration
        </button>
      </div>
    </div>
  );
}

export interface PastillesProjet {
  iactionPath: string | null;
  claudeMdPath: string | null;
  claudeDirPath: string | null;
}

/** Pastilles du projet sélectionné : `.iaction`, `CLAUDE.md` (cliquable), `.claude/`. Rien si aucune n'existe. */
export function BadgesProjet({
  badges,
  onOpenClaudeMd,
}: Readonly<{ badges: PastillesProjet; onOpenClaudeMd: (chemin: string) => void }>) {
  if (!badges.iactionPath && !badges.claudeMdPath && !badges.claudeDirPath) return null;
  return (
    <div className="project-badges">
      {badges.iactionPath && (
        <span className="project-badge" title="Dossier de config du projet — agents, doc IA, RAG (v2)">
          ⚙ .iaction
        </span>
      )}
      {badges.claudeMdPath && (
        <button
          type="button"
          className="project-badge project-badge--link"
          title="Instructions projet — lues automatiquement par le moteur Claude"
          onClick={() => onOpenClaudeMd(badges.claudeMdPath as string)}
        >
          📄 CLAUDE.md
        </button>
      )}
      {badges.claudeDirPath && (
        <span className="project-badge" title="Config Claude Code existante — agents, commandes, permissions">
          🤖 .claude/
        </span>
      )}
    </div>
  );
}

/** Bandeaux sous la barre d'onglets : avis ponctuel, « conversation vidée », débord (R3), réveil (T-120). */
export function BandeauxOnglets({
  avis,
  videe,
  onAnnulerVidage,
  onMasquerVidage,
  debord,
  debordInstant,
  reveil,
}: Readonly<{
  avis: string | null;
  videe: boolean;
  onAnnulerVidage: () => void;
  onMasquerVidage: () => void;
  debord: DebordNotice | null;
  debordInstant: number | string | null;
  reveil: { label: string } | null;
}>) {
  return (
    <>
      {avis && <div className="agent-tabs__notice">{avis}</div>}
      {videe && (
        <div className="agent-tabs__notice cleared-notice">
          Conversation vidée.
          <button type="button" className="btn btn--ghost cleared-notice__undo" onClick={onAnnulerVidage}>
            Annuler
          </button>
          <button
            type="button"
            className="cleared-notice__dismiss"
            onClick={onMasquerVidage}
            aria-label="Masquer"
            title="Masquer"
          >
            ×
          </button>
        </div>
      )}
      {/* R3 — bandeau de débord : posé au tour concerné, effacé dès que le
          routage redevient normal (voir applyDebordNotice). */}
      {debord && (
        <div className={`agent-tabs__notice debord-notice${debord.blocked ? " debord-notice--blocked" : ""}`}>
          <NoticeEnTete instant={debordInstant}>{libelleDebordNotice(debord)}</NoticeEnTete>
        </div>
      )}
      {/* T-120 — trace du dernier réveil honoré ou abandonné (§6) : même
          registre que le bandeau de débord juste au-dessus. */}
      {reveil && <div className="agent-tabs__notice">{reveil.label}</div>}
    </>
  );
}
