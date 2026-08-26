/*
 * Panneau « Mise à jour » de la page Système (T-056).
 *
 * ── Ce qu'il fait, et ce qu'il ne fait pas ──────────────────────────────
 * Il DIT qu'une version existe, et ouvre la page de téléchargement. Il ne
 * télécharge rien et n'installe rien : c'est l'installeur NSIS qui met à jour
 * en place, ce qu'il sait déjà faire (page « mettre à jour / réinstaller »,
 * voir src-tauri/nsis/installer.nsi). Le jour où l'application s'installera
 * elle-même, ce sera une décision explicite — clés de signature, artefacts
 * signés en CI — pas une dérive de ce panneau.
 *
 * ── Pourquoi il ne crie jamais ──────────────────────────────────────────
 * La sonde est un confort. Hors ligne, derrière un proxy qui refuse, ou sur
 * une construction locale en avance sur la dernière release, elle ne sait pas
 * — et elle le dit sobrement, sans bandeau rouge. Une application qui ignore
 * si elle est à jour n'est pas une application en panne.
 */
import { useEffect, useState } from "react";

import { Markdown } from "./Markdown";
import { majVerifier, type EtatMaj } from "./majClient";
import { ouvrirLienExterne } from "./refFichier";

type Etat = { phase: "attente" } | { phase: "su"; maj: EtatMaj } | { phase: "muette" };

/**
 * Bouton d'ouverture de la release. Composant séparé pour que `url` arrive
 * déjà non-nulle : refermer un `maj.url` nullable dans un gestionnaire de clic
 * obligeait à une assertion de type, c'est-à-dire à affirmer au compilateur ce
 * qu'une garde JSX ne lui prouve pas.
 */
function BoutonTelecharger({ url, version }: Readonly<{ url: string; version: string | null }>) {
  return (
    <button
      className="btn btn--allow"
      onClick={() => {
        ouvrirLienExterne(url).catch(() => {
          /* navigateur indisponible : le lien reste lisible dans les nouveautés */
        });
      }}
    >
      Télécharger la {version}
    </button>
  );
}

export function MajPanel() {
  const [etat, setEtat] = useState<Etat>({ phase: "attente" });
  const [notesOuvertes, setNotesOuvertes] = useState(false);

  function verifier() {
    setEtat({ phase: "attente" });
    majVerifier()
      .then((maj) => setEtat({ phase: "su", maj }))
      .catch(() => setEtat({ phase: "muette" }));
  }

  // Une seule vérification au montage de la page, et une autre seulement si
  // on la demande. Surtout pas de sondage périodique : une release ne sort pas
  // toutes les cinq minutes, et c'est exactement l'excès que T-054 et T-055
  // viennent de corriger ailleurs.
  useEffect(() => {
    let annule = false;
    majVerifier()
      .then((maj) => {
        if (!annule) setEtat({ phase: "su", maj });
      })
      .catch(() => {
        if (!annule) setEtat({ phase: "muette" });
      });
    return () => {
      annule = true;
    };
  }, []);

  const maj = etat.phase === "su" ? etat.maj : null;

  return (
    <section className="panel">
      <h2 className="panel__title">Mise à jour</h2>
      <p className="empty-hint">
        Compare la version installée à la dernière publiée sur le dépôt. Rien n'est téléchargé ni installé
        automatiquement : le bouton ouvre la page de la release, et l'installeur met à jour en place.
      </p>

      <div className="result-line">
        {etat.phase === "attente" && "Vérification…"}
        {etat.phase === "muette" &&
          "Impossible de joindre le dépôt (hors ligne, ou proxy). Version installée inconnue de la sonde."}
        {maj && !maj.disponible && `Version ${maj.courante} — à jour.`}
        {maj?.disponible && `Version ${maj.courante} installée — ${maj.derniere} est disponible.`}
      </div>

      <div className="actions">
        <button className="btn" onClick={verifier} disabled={etat.phase === "attente"}>
          {etat.phase === "attente" ? "Vérification…" : "Vérifier maintenant"}
        </button>
        {maj?.disponible && maj.url !== null && (
          <BoutonTelecharger url={maj.url} version={maj.derniere} />
        )}
        {maj?.disponible && maj.notes && (
          <button className="btn" onClick={() => setNotesOuvertes((v) => !v)}>
            {notesOuvertes ? "Masquer les nouveautés" : "Voir les nouveautés"}
          </button>
        )}
      </div>

      {notesOuvertes && maj?.notes && (
        <div className="maj-panel__notes">
          <Markdown content={maj.notes} />
        </div>
      )}
    </section>
  );
}
