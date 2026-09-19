/*
 * Contrôle « Réveil » (docs/spec-reveil.md §7) — PARTAGÉ entre ChatPage.tsx et
 * AgentPage.tsx : la liste des réveils armés, le formulaire (heures, case
 * reset-quota, message) et l'affichage des échéances sont identiques dans les
 * deux pages ; seul ce qui entoure (écrire dans une `ChatSession` ou une
 * `ProjectSession`) diffère — laissé à l'appelant via `onEnregistrer`/`onSupprimer`.
 *
 * Volontairement à côté de « En file : … », pas dedans : un réveil n'est pas
 * une file, c'est une PROMESSE pour plus tard (voir reveil.ts, §2 de la spec
 * — aucun chemin d'envoi ici, seulement une décision temporelle et un objet
 * `Reveil` construit puis confié à l'appelant).
 *
 * ── Deux constats d'usage du 2026-09-04, et ce qu'ils ont changé ─────────
 * 1. « On ne voit pas bien quand c'est armé. » Le bouton repliait TOUT, état
 *    compris : un réveil armé ressemblait à un réveil absent. Désormais l'état
 *    armé est affiché EN PERMANENCE, hors du panneau — pastille, nombre,
 *    prochaine échéance en clair — et le bouton lui-même change d'allure.
 *    Une promesse qu'on ne voit pas est une promesse qu'on ne croit pas.
 * 2. « Quand on ajoute un autre réveil, on ne peut pas revenir sur l'autre à
 *    part pour supprimer. » Les heures n'étaient que des pastilles à détruire,
 *    et un unique message valait pour toutes. Désormais : plusieurs réveils,
 *    chacun son message, chacun REPRENABLE — « Modifier » recharge le
 *    formulaire, l'enregistrement remplace l'original (apparié par `id`).
 * 3. « Ça prend un bandeau pour rien. » (2026-09-05) Le bouton occupait une
 *    ligne entière du composeur en permanence, y compris quand aucun réveil
 *    n'était armé — c'est-à-dire la plupart du temps. Il descend donc dans la
 *    COLONNE d'icônes, avec le trombone et le micro, où vivent les actions
 *    secondaires : zéro ligne consommée. L'état armé, lui, garde son bandeau
 *    — mais SEULEMENT quand il y a quelque chose à annoncer.
 *
 * D'où deux exports : `ReveilBanniere` (l'état, en haut du composeur, absent
 * quand rien n'est armé) et `ReveilControl` (l'icône et son panneau, dans la
 * colonne d'outils). Deux endroits du DOM, donc deux composants — plutôt
 * qu'un portail, qui coûterait plus cher à lire qu'à écrire.
 *
 * ── Pourquoi le panneau est ancré en `position: fixed` (2026-09-05) ──────
 * Depuis que la colonne d'icônes a quitté le composeur pour le panneau
 * latéral gauche (section « Outils » d'AgentPage.tsx), l'icône vit dans une
 * colonne de 300 px dont les ancêtres RECOUPENT (`.agent-sidebar` en
 * `overflow-y:auto`, `.sidebar-section` en `overflow:hidden`) : un panneau
 * `position:absolute` de 520 px y était rogné, voire invisible. Il est donc
 * mesuré à l'ouverture depuis le rectangle de l'icône et posé en `fixed`,
 * comme le menu contextuel de FileTree.tsx — le `fixed` échappe aux
 * découpes puisqu'aucun ancêtre ne crée de bloc conteneur (pas de
 * `transform`/`filter` sur ces colonnes). Il s'ouvre vers le HAUT quand la
 * place le permet, vers le bas sinon.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { instantReouvertureQuota } from "./reouvertureQuota";
import { BATTEMENT_REVEIL_MS } from "./reveilRuntime";
import {
  estHeureValide,
  heuresAvecSaisie,
  nouvelIdReveil,
  prochaineEcheance,
  prochaineEcheanceListe,
  type Reveil,
  type ReveilHistorise,
} from "./reveil";

/** « aujourd'hui 03:00 », « demain 03:00 », ou une date complète au-delà — jamais juste un horodatage brut illisible. */
function libelleEcheance(ms: number, maintenant: number): string {
  const cible = new Date(ms);
  const jourCible = new Date(cible.getFullYear(), cible.getMonth(), cible.getDate()).getTime();
  const jourAujourdhui = new Date(new Date(maintenant).setHours(0, 0, 0, 0)).getTime();
  const heure = cible.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const joursEcart = Math.round((jourCible - jourAujourdhui) / 86_400_000);
  if (joursEcart === 0) return `aujourd'hui ${heure}`;
  if (joursEcart === 1) return `demain ${heure}`;
  return `${cible.toLocaleDateString("fr-FR")} ${heure}`;
}

/** Ce qu'un réveil déclenchera, en une ligne : de quoi le reconnaître dans la liste sans l'ouvrir. */
function resumeMessage(reveil: Reveil): string {
  const texte = reveil.prompts.join(" ").trim();
  return texte.length > 60 ? `${texte.slice(0, 60)}…` : texte;
}

/** Les heures d'un réveil, telles qu'on les lit : « 03:00, 08:00 + réouverture du quota ». */
function resumeHeures(reveil: Reveil): string {
  const parts = [...reveil.heures];
  if (reveil.surResetQuota) parts.push("réouverture du quota");
  return parts.length > 0 ? parts.join(", ") : "aucune heure";
}

/** Écart entre l'icône et son panneau, et marge minimale gardée aux bords de l'écran. */
const MARGE_PANNEAU = 6;
/** Doit rester d'accord avec `width` / `max-width` de `.reveil-control__panel` (App.css). */
const LARGEUR_MAX_PANNEAU = 520;
/** Part de la hauteur d'écran que le panneau ne dépasse jamais, quel que soit le côté choisi. */
const PART_HAUTEUR_PANNEAU = 0.6;

export interface AncrePanneau {
  left: number;
  /** Renseigné quand le panneau s'ouvre vers le BAS ; exclusif avec `bottom`. */
  top?: number;
  /** Renseigné quand le panneau s'ouvre vers le HAUT ; exclusif avec `top`. */
  bottom?: number;
  maxHeight: number;
}

/**
 * Où poser le panneau flottant, connaissant le rectangle de son icône : vers
 * le HAUT tant qu'il y a de quoi l'afficher (le geste habituel — le panneau
 * ne recouvre pas ce qu'on vient de cliquer), vers le bas sinon. Recalé
 * horizontalement pour ne jamais déborder de l'écran : dans une colonne
 * latérale de 300 px, un panneau de 520 px aligné à gauche sortirait sinon
 * de la fenêtre.
 *
 * Fonction PURE (la vue est un paramètre, pas une lecture de `window`) : la
 * décision se prouve sans DOM, conformément à la doctrine du projet.
 */
export function ancrerPanneau(
  icone: { left: number; top: number; bottom: number },
  vue: { largeur: number; hauteur: number },
): AncrePanneau {
  const largeur = Math.min(LARGEUR_MAX_PANNEAU, vue.largeur * 0.7);
  const left = Math.max(MARGE_PANNEAU, Math.min(icone.left, vue.largeur - largeur - MARGE_PANNEAU));
  const plafond = vue.hauteur * PART_HAUTEUR_PANNEAU;
  const placeDessus = icone.top - MARGE_PANNEAU;
  const placeDessous = vue.hauteur - icone.bottom - MARGE_PANNEAU;
  // On ne bascule vers le bas que si le dessus est VRAIMENT plus étroit :
  // à égalité, le haut garde la main (le panneau ne masque pas l'icône).
  if (placeDessus >= placeDessous || placeDessus >= plafond) {
    return { left, bottom: vue.hauteur - icone.top + MARGE_PANNEAU, maxHeight: Math.min(plafond, placeDessus) };
  }
  return { left, top: icone.bottom + MARGE_PANNEAU, maxHeight: Math.min(plafond, placeDessous) };
}

/**
 * État armé, en haut du composeur — RIEN quand aucun réveil n'est armé, ce qui
 * est le cas le plus fréquent (constat 3). Sans état interne : tout se déduit
 * des réveils, l'ouverture du panneau appartient à l'icône.
 */
export function ReveilBanniere({ reveils }: Readonly<{ reveils: Reveil[] }>) {
  if (reveils.length === 0) return null;
  const maintenant = Date.now();
  const prochaine = prochaineEcheanceListe(reveils, maintenant);
  return (
    <div className="reveil-banniere">
      <span className="reveil-control__pastille" aria-hidden="true" />
      <strong>
        {reveils.length} réveil{reveils.length > 1 ? "s" : ""} armé{reveils.length > 1 ? "s" : ""}
      </strong>
      {prochaine !== null ? (
        <span> — prochain {libelleEcheance(prochaine, maintenant)}</span>
      ) : (
        /* Un réveil armé dont l'échéance n'est pas calculable n'est pas un
           réveil, c'est un espoir — §7 le dit, autant le dire à l'écran. */
        <span> — aucune échéance calculable, à réarmer</span>
      )}
    </div>
  );
}

export function ReveilControl({
  reveils,
  historique,
  brouillon,
  onEnregistrer,
  onSupprimer,
}: Readonly<{
  /** Réveils actuellement armés sur cette conversation (liste vide = aucun). */
  reveils: Reveil[];
  /** Réveils déjà passés, du plus ancien au plus récent — un réveil ne sert qu'une fois. */
  historique: ReveilHistorise[];
  /** Brouillon courant du composeur — préremplit le message d'un réveil NEUF (§7). */
  brouillon: string;
  /** Enregistre un réveil neuf, ou remplace celui de même `id`. */
  onEnregistrer: (reveil: Reveil) => void;
  onSupprimer: (id: string) => void;
}>) {
  const [ouvert, setOuvert] = useState(false);
  /** `id` du réveil en cours de modification, `null` pour un réveil neuf. */
  const [editionId, setEditionId] = useState<string | null>(null);
  const [heures, setHeures] = useState<string[]>([]);
  const [champHeure, setChampHeure] = useState("");
  const [surResetQuota, setSurResetQuota] = useState(false);
  const [texte, setTexte] = useState("");
  const [historiqueOuvert, setHistoriqueOuvert] = useState(false);

  /*
   * Ancrage du panneau (voir l'entête) : mesuré à l'ouverture depuis le
   * rectangle de l'icône, puis re-mesuré tant qu'il reste ouvert — un
   * redimensionnement de la fenêtre ou le défilement de la colonne latérale
   * déplacent l'icône, et un panneau `fixed` ne suit rien tout seul.
   */
  const iconeRef = useRef<HTMLButtonElement>(null);
  const [ancre, setAncre] = useState<AncrePanneau | null>(null);
  useLayoutEffect(() => {
    if (!ouvert) {
      setAncre(null);
      return;
    }
    const mesurer = () => {
      const bouton = iconeRef.current;
      if (!bouton) return;
      const r = bouton.getBoundingClientRect();
      setAncre(ancrerPanneau(r, { largeur: window.innerWidth, hauteur: window.innerHeight }));
    };
    mesurer();
    window.addEventListener("resize", mesurer);
    // Capture : le défilement d'un conteneur interne (la colonne latérale, le
    // fil) ne remonte pas jusqu'à `window` autrement.
    window.addEventListener("scroll", mesurer, true);
    return () => {
      window.removeEventListener("resize", mesurer);
      window.removeEventListener("scroll", mesurer, true);
    };
  }, [ouvert]);

  /*
   * Battement d'affichage — même cadence que celui des réveils (30 s).
   *
   * Deux choses en dépendent, et les deux se voyaient mal sans lui :
   * « prochain dans 2 h » qui se périme en silence, et surtout l'armabilité —
   * `instantReouvertureQuota` lit un magasin écrit AILLEURS (par l'encart de
   * conso, quand un relevé arrive). Sans re-rendu, un panneau ouvert avant
   * l'arrivée du relevé resterait indéfiniment sur « aucune date connue »,
   * bouton grisé, alors que l'application sait désormais répondre.
   *
   * Seulement quand il y a quelque chose à rafraîchir : panneau ouvert, ou
   * bannière d'état affichée.
   */
  const [, battre] = useState(0);
  const doitBattre = ouvert || reveils.length > 0;
  useEffect(() => {
    if (!doitBattre) return;
    const id = setInterval(() => battre((n) => n + 1), BATTEMENT_REVEIL_MS);
    return () => clearInterval(id);
  }, [doitBattre]);

  const maintenant = Date.now();
  const reouverture = instantReouvertureQuota(maintenant);
  const prochaine = prochaineEcheanceListe(reveils, maintenant);

  /** Formulaire vierge, message prérempli avec le brouillon en cours : « ce que je viens d'écrire, envoie-le à 3 h ». */
  function ouvrirNeuf() {
    setEditionId(null);
    setHeures([]);
    setChampHeure("");
    setSurResetQuota(false);
    setTexte(brouillon);
    setOuvert(true);
  }

  /** Recharge un réveil existant dans le formulaire — c'est ça, « revenir dessus ». */
  function ouvrirEdition(reveil: Reveil) {
    setEditionId(reveil.id);
    setHeures(reveil.heures);
    setChampHeure("");
    setSurResetQuota(reveil.surResetQuota);
    setTexte(reveil.prompts.join("\n"));
    setOuvert(true);
  }

  /** « Ajouter » ne sert plus qu'à saisir une SECONDE heure : la première compte dès qu'elle est tapée (voir heuresAvecSaisie). */
  function ajouterHeure() {
    setHeures((h) => heuresAvecSaisie(h, champHeure));
    setChampHeure("");
  }

  // L'heure encore dans le champ compte comme armée : taper une heure EST
  // l'intention de l'ajouter (constat du 2026-09-04).
  const heuresEffectives = heuresAvecSaisie(heures, champHeure);
  const promptsCandidats = texte.trim() ? [texte.trim()] : [];
  const candidat: Reveil = {
    id: editionId ?? nouvelIdReveil(),
    heures: heuresEffectives,
    surResetQuota,
    // Cible FIGÉE à l'armement (voir reveil.ts) : le réveil ne redemandera
    // jamais cette date au monde, donc elle ne peut plus lui être retirée
    // sous les pieds — ni sauter à la réouverture suivante.
    cibleReouverture: surResetQuota && reouverture !== null ? new Date(reouverture).toISOString() : null,
    prompts: promptsCandidats,
    // Posé à l'instant de l'enregistrement, pas `null` : sans ça, un réveil
    // tout juste créé se croirait en retard sur l'occurrence de LA VEILLE de
    // chaque heure armée (`estDu` remonte à la dernière occurrence passée,
    // quelle que soit son ancienneté) — voir reveilRuntime.test.ts.
    dernierDeclenchement: new Date(maintenant).toISOString(),
  };
  const echeanceCandidate = prochaineEcheance(candidat, maintenant);
  const saisieEnCours = champHeure.trim();
  const motifRefus =
    promptsCandidats.length === 0
      ? "Écrivez ce qui doit repartir : un réveil sans rien à envoyer ne sert à rien."
      : echeanceCandidate !== null
        ? null
        : // Dire CE QUI cloche précisément : un bouton grisé dont le motif est
          // générique fait chercher l'erreur au mauvais endroit.
          saisieEnCours !== "" && !estHeureValide(saisieEnCours)
          ? `« ${saisieEnCours} » n'est pas une heure valide — format HH:MM, par exemple 03:00.`
          : surResetQuota
            ? // Case cochée mais aucune réouverture connue : l'app n'a pas
              // encore reçu un seul relevé de quota exploitable. Le dire, au
              // lieu de laisser croire que la case ne sert à rien.
              "Aucune date de réouverture de quota connue pour l'instant (aucun relevé reçu) — ajoutez une heure en attendant."
            : "Indiquez une heure (HH:MM), ou cochez la réouverture de quota.";

  function enregistrer() {
    if (motifRefus !== null) return;
    onEnregistrer(candidat);
    setChampHeure("");
    setOuvert(false);
  }

  const titreIcone =
    reveils.length === 0
      ? "Réveil — programmer une reprise"
      : prochaine !== null
        ? `${reveils.length} réveil${reveils.length > 1 ? "s" : ""} armé${reveils.length > 1 ? "s" : ""} — prochain ${libelleEcheance(prochaine, maintenant)}`
        : `${reveils.length} réveil${reveils.length > 1 ? "s" : ""} armé${reveils.length > 1 ? "s" : ""} — sans échéance, à réarmer`;

  return (
    <div className={`reveil-control${reveils.length > 0 ? " reveil-control--arme" : ""}`}>
      <button
        ref={iconeRef}
        type="button"
        className="btn btn--ghost reveil-control__icone"
        onClick={() => setOuvert((o) => !o)}
        title={titreIcone}
        aria-label={titreIcone}
        aria-expanded={ouvert}
      >
        ⏰
        {/* Le point reprend celui de la bannière : même signal, deux tailles. */}
        {reveils.length > 0 && <span className="reveil-control__pastille" aria-hidden="true" />}
      </button>

      {ouvert && (
        <div
          className="reveil-control__panel"
          style={
            ancre
              ? { left: ancre.left, top: ancre.top, bottom: ancre.bottom, maxHeight: ancre.maxHeight }
              : // Toute première frappe de rendu : le `useLayoutEffect` mesure
                // avant la peinture, ce voile n'est donc jamais vu — il évite
                // seulement le clignotement en haut à gauche de l'écran.
                { visibility: "hidden" }
          }
        >
          <div className="reveil-control__barre">
            <strong>Réveil</strong>
            <button type="button" className="btn btn--ghost" onClick={ouvrirNeuf}>
              + Nouveau
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setOuvert(false)} aria-label="Fermer">
              ×
            </button>
          </div>
          {/* La liste : chaque réveil se relit, se reprend et se supprime (constat 2). */}
          {reveils.length > 0 && (
            <ul className="reveil-control__liste">
              {reveils.map((r) => {
                const echeance = prochaineEcheance(r, maintenant);
                return (
                  <li key={r.id} className={`reveil-control__item${r.id === editionId ? " reveil-control__item--edite" : ""}`}>
                    <div className="reveil-control__item-infos">
                      <span className="reveil-control__item-heures">{resumeHeures(r)}</span>
                      <span className="reveil-control__item-message">{resumeMessage(r)}</span>
                      <span className="reveil-control__item-echeance">
                        {echeance !== null
                          ? `prochain ${libelleEcheance(echeance, maintenant)}`
                          : r.surResetQuota && !r.cibleReouverture
                            ? // Armé avant que la cible ne soit figée, ou alors
                              // qu'aucune réouverture n'était connue : il ne
                              // partira jamais. Le dire, et dire quoi faire.
                              "inerte — aucune réouverture visée, à réarmer"
                            : "inerte"}
                      </span>
                    </div>
                    <div className="reveil-control__item-actions">
                      <button type="button" className="btn btn--ghost" onClick={() => ouvrirEdition(r)}>
                        Modifier
                      </button>
                      <button type="button" className="btn btn--ghost" onClick={() => onSupprimer(r.id)}>
                        Supprimer
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="reveil-control__statut">
            {editionId ? "Modification d'un réveil existant" : "Nouveau réveil"}
          </p>

          <div className="reveil-control__heures">
            {heures.map((h) => (
              <span key={h} className="reveil-control__heure">
                {h}
                <button
                  type="button"
                  onClick={() => setHeures((prev) => prev.filter((x) => x !== h))}
                  aria-label={`Retirer ${h}`}
                  title="Retirer cette heure"
                >
                  ×
                </button>
              </span>
            ))}
            <input
              type="text"
              inputMode="numeric"
              placeholder="HH:MM"
              value={champHeure}
              onChange={(e) => setChampHeure(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  ajouterHeure();
                }
              }}
            />
            <button
              type="button"
              className="btn btn--ghost"
              onClick={ajouterHeure}
              disabled={!estHeureValide(champHeure)}
            >
              Ajouter
            </button>
          </div>

          <label className="reveil-control__reset">
            <input type="checkbox" checked={surResetQuota} onChange={(e) => setSurResetQuota(e.currentTarget.checked)} />
            et dès que la fenêtre de quota se rouvre
          </label>

          <textarea
            rows={3}
            placeholder="Ce qui repartira au réveil…"
            value={texte}
            onChange={(e) => setTexte(e.currentTarget.value)}
          />

          <div className="reveil-control__actions">
            <button type="button" className="btn" disabled={motifRefus !== null} title={motifRefus ?? undefined} onClick={enregistrer}>
              {editionId ? "Enregistrer les modifications" : "Armer"}
            </button>
            {editionId && (
              <button type="button" className="btn btn--ghost" onClick={ouvrirNeuf}>
                Abandonner la modification
              </button>
            )}
          </div>
          {motifRefus && <p className="reveil-control__motif">{motifRefus}</p>}

          {/* Historique : un réveil ne se ré-arme pas, il disparaîtrait donc
              de l'écran sitôt son travail fait. Replié par défaut — c'est une
              trace qu'on consulte, pas un tableau de bord. */}
          {historique.length > 0 && (
            <div className="reveil-control__historique">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setHistoriqueOuvert((o) => !o)}
                aria-expanded={historiqueOuvert}
              >
                {historiqueOuvert ? "▾" : "▸"} Historique ({historique.length})
              </button>
              {historiqueOuvert && (
                <ul className="reveil-control__liste">
                  {[...historique].reverse().map((h) => (
                    <li key={`${h.id}-${h.traiteA}`} className="reveil-control__item">
                      <div className="reveil-control__item-infos">
                        <span
                          className={`reveil-control__issue reveil-control__issue--${h.issue}`}
                          title={
                            h.issue === "declenche"
                              ? "Les messages sont partis"
                              : "Échéance manquée de plus de 6 h : rien n'est parti"
                          }
                        >
                          {h.issue === "declenche" ? "parti" : "abandonné"}
                        </span>
                        <span className="reveil-control__item-heures">
                          {libelleEcheance(new Date(h.echeance).getTime(), maintenant)}
                        </span>
                        <span className="reveil-control__item-message">{h.prompts.join(" ")}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
