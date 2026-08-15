/*
 * T-032 — Sélecteur de modèle filtrable (Chat + Projets).
 *
 * ── Pourquoi ce n'est plus un <select> ─────────────────────────────────
 * OpenRouter publie plusieurs centaines de modèles. Un `<select>` natif ne se
 * filtre pas, ne montre qu'une ligne de texte par entrée, et son popup est
 * rendu par le système : ni prix, ni contexte, ni étoile de favori. Le
 * confort ici n'est pas décoratif — choisir un modèle, c'est arbitrer un coût.
 *
 * ── Pourquoi un portail ────────────────────────────────────────────────
 * Le sélecteur vit dans `.sidebar-section`, qui porte `overflow: hidden`
 * (App.css) : un popover en `position: absolute` y serait COUPÉ. Il est donc
 * rendu dans `document.body` en `position: fixed`, aux coordonnées du bouton
 * — recalculées au défilement et au redimensionnement plutôt que fermées,
 * pour que la liste ne disparaisse pas sous le doigt.
 *
 * Toute la décision (filtres, groupes, ordre) est dans modelPickerCalc.ts, testée
 * sans fenêtre. Ce fichier ne fait que du DOM, du focus et du clavier.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { fuzzyScore } from "./fuzzy";
import { formatContext, formatPricing, MODEL_SORT_OPTIONS, type ModelSortKey } from "./modelCatalog";
import {
  construireListe,
  editeurDe,
  estGratuit,
  FILTRE_INITIAL,
  rangEditeur,
  suffixeVariante,
  TRAFIC_DISCLAIMER,
  type FiltreModeles,
} from "./modelPickerCalc";
import type { ModelDetail } from "./sidecar";

/**
 * Entrée qui n'est pas un modèle du catalogue mais doit rester choisissable :
 * la sentinelle « Auto » (R1/R2), les modèles Claude de l'abonnement. Toujours
 * en tête, jamais masquée par le filtre des variantes.
 */
export interface OptionEpinglee {
  value: string;
  label: string;
  title?: string;
}

interface ModelPickerProps {
  /** Id du bouton déclencheur — cible du `<label htmlFor>` de la fiche. */
  id: string;
  value: string;
  onChange: (value: string) => void;
  models: ModelDetail[];
  epingles?: OptionEpinglee[];
  favoris?: string[];
  /** Absent = pas d'étoile (fournisseur sans favoris, ex. Claude abonnement). */
  onToggleFavori?: (modelId: string) => void;
  disabled?: boolean;
  chargement?: boolean;
  /**
   * T-025 — recherche web R9 active : les agents `…-with-search` sont écartés,
   * puisque nous cherchons déjà pour eux et que leur propre recherche est ce
   * qui casse (2 échecs sur 6 mesurés le 2026-08-11).
   */
  rechercheWebActive?: boolean;
}

/** Hauteur maximale du popover, en px — sert aussi à décider s'il s'ouvre vers le haut. */
const HAUTEUR_MAX = 460;
const LARGEUR_MIN = 360;

interface Position {
  left: number;
  width: number;
  /** L'un des deux seulement : `top` (ouverture vers le bas) ou `bottom` (vers le haut). */
  top?: number;
  bottom?: number;
}

function calculerPosition(bouton: HTMLElement): Position {
  const rect = bouton.getBoundingClientRect();
  const width = Math.max(rect.width, LARGEUR_MIN);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const placeEnDessous = window.innerHeight - rect.bottom;
  return placeEnDessous >= HAUTEUR_MAX || placeEnDessous >= rect.top
    ? { left, width, top: rect.bottom + 4 }
    : { left, width, bottom: window.innerHeight - rect.top + 4 };
}

/**
 * Ligne rendue. Les en-têtes ne sont pas dans la navigation par flèches —
 * ce sont de vrais `<button>`, atteints par Tab et actionnés par Entrée/Espace
 * comme n'importe quel bouton, sans clavier maison à réinventer.
 */
type Ligne =
  | { type: "entete"; cle: string; texte: string; editeur: string | null; deplie: boolean }
  | { type: "epingle"; cle: string; index: number; option: OptionEpinglee }
  | { type: "modele"; cle: string; index: number; model: ModelDetail; favori: boolean };

export function ModelPicker({
  id,
  value,
  onChange,
  models,
  epingles = [],
  favoris = [],
  onToggleFavori,
  disabled = false,
  chargement = false,
  rechercheWebActive = false,
}: Readonly<ModelPickerProps>) {
  const [ouvert, setOuvert] = useState(false);
  const [filtre, setFiltre] = useState<FiltreModeles>(FILTRE_INITIAL);
  const [actif, setActif] = useState(0);
  /*
   * Pli des groupes d'éditeurs : SEULEMENT les choix explicites de
   * l'utilisateur (`true` déplié, `false` replié). L'absence d'entrée n'est pas
   * « replié », c'est « pas encore décidé » — et c'est `estDeplie` qui tranche
   * alors selon le contexte. Deux états distincts, sinon un groupe déplié par
   * la recherche ne pourrait plus être replié à la main.
   */
  const [choixPli, setChoixPli] = useState<Record<string, boolean>>({});
  const [position, setPosition] = useState<Position | null>(null);
  const boutonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listeRef = useRef<HTMLUListElement>(null);
  const baseId = useId();

  const parId = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);
  const epingleCourant = epingles.find((o) => o.value === value);
  const modeleCourant = parId.get(value);

  // `rechercheWebActive` n'est pas une préférence d'affichage : elle vient de
  // l'état de R9, pas des puces du popover — d'où la fusion ici plutôt qu'un
  // champ de plus dans l'état local (que « Réinitialiser » remettrait à faux).
  const liste = useMemo(
    () => construireListe(models, favoris, { ...filtre, rechercheWebActive }, value),
    [models, favoris, filtre, value, rechercheWebActive],
  );

  const epinglesFiltres = useMemo(() => {
    const q = filtre.recherche.trim();
    if (!q) return epingles;
    return epingles.filter((o) => fuzzyScore(`${o.label} ${o.value}`, q) !== null);
  }, [epingles, filtre.recherche]);

  /*
   * Un groupe est-il déplié ? Par défaut REPLIÉ — un catalogue OpenRouter
   * ouvre sinon sur trois cents lignes, ce qui était le reproche d'origine.
   * Trois exceptions, toutes destinées à ne rien cacher qui soit demandé :
   *  - une recherche en cours déplie tout, sans quoi elle semblerait ne rien
   *    trouver alors que les résultats sont sous des en-têtes fermés ;
   *  - le groupe du modèle SÉLECTIONNÉ s'ouvre : la liste s'ouvre sur « où
   *    j'en suis », pas sur un mur d'éditeurs ;
   *  - un choix explicite prime sur tout le reste, dans les deux sens.
   */
  const editeurCourant = editeurDe(value);
  const rechercheActive = filtre.recherche.trim() !== "";
  const estDeplie = useCallback(
    (editeur: string) => choixPli[editeur] ?? (rechercheActive || editeur === editeurCourant),
    [choixPli, rechercheActive, editeurCourant],
  );

  /* Lignes rendues et navigables, dans le MÊME ordre : les flèches suivent ce
     que l'œil voit — donc jamais un modèle caché dans un groupe replié — et
     l'index d'une option est sa position ici. */
  const { lignes, options } = useMemo(() => {
    const lignes: Ligne[] = [];
    const options: string[] = [];
    const pousserEpingle = (option: OptionEpinglee) => {
      lignes.push({ type: "epingle", cle: `ep-${option.value}`, index: options.length, option });
      options.push(option.value);
    };
    const pousserModele = (model: ModelDetail, favori: boolean) => {
      lignes.push({ type: "modele", cle: `md-${model.id}`, index: options.length, model, favori });
      options.push(model.id);
    };
    epinglesFiltres.forEach(pousserEpingle);
    // Favoris : jamais pliés. Les replier reviendrait à cacher précisément ce
    // que l'utilisateur a désigné comme ce qu'il veut voir en premier.
    if (liste.favoris.length > 0) {
      lignes.push({ type: "entete", cle: "h-fav", texte: "Favoris", editeur: null, deplie: true });
      liste.favoris.forEach((m) => pousserModele(m, true));
    }
    /*
     * Un en-tête par ÉDITEUR, avec son compte : c'est lui qui dit d'un coup
     * d'œil qu'une maison publie trois modèles et une autre soixante — et
     * c'est ce qui rend le repli lisible, un groupe fermé annonçant ce qu'il
     * contient. Cas particulier des ids sans éditeur (Ollama) : s'ils sont le
     * seul groupe, « Sans éditeur » n'apprend rien, et le replier cacherait
     * tout le catalogue derrière une ligne — il reste donc déplié.
     */
    const seulGroupe = liste.groupes.length === 1;
    for (const groupe of liste.groupes) {
      const anonymeSeul = groupe.editeur === "" && seulGroupe;
      const nom = groupe.editeur || (seulGroupe ? "Modèles" : "Sans éditeur");
      const deplie = anonymeSeul || estDeplie(groupe.editeur);
      lignes.push({
        type: "entete",
        cle: `h-${groupe.editeur}`,
        texte: `${nom} · ${groupe.models.length}`,
        editeur: anonymeSeul ? null : groupe.editeur,
        deplie,
      });
      if (deplie) groupe.models.forEach((m) => pousserModele(m, false));
    }
    return { lignes, options };
  }, [epinglesFiltres, liste, estDeplie]);

  const fermer = useCallback(() => {
    setOuvert(false);
    setFiltre(FILTRE_INITIAL);
    setChoixPli({});
    boutonRef.current?.focus();
  }, []);

  const ouvrir = useCallback(() => {
    const bouton = boutonRef.current;
    if (!bouton) return;
    setPosition(calculerPosition(bouton));
    setFiltre(FILTRE_INITIAL);
    // Le pli repart à zéro à chaque ouverture : la liste s'ouvre toujours de la
    // même façon, plutôt que dans l'état où une consultation précédente l'a
    // laissée — un dépliage fait pour comparer deux modèles n'a pas vocation
    // à survivre au choix qui l'a conclu.
    setChoixPli({});
    setOuvert(true);
  }, []);

  // Position suivie plutôt que figée : la barre latérale défile, et un popover
  // `fixed` resterait sinon accroché à la place que le bouton occupait.
  useEffect(() => {
    if (!ouvert) return;
    const suivre = (e: Event) => {
      // Le défilement DANS la liste ne déplace pas le bouton : l'ignorer,
      // sinon chaque cran de molette recalcule pour rien.
      if (e.type === "scroll" && popoverRef.current?.contains(e.target as Node)) return;
      const bouton = boutonRef.current;
      if (bouton) setPosition(calculerPosition(bouton));
    };
    window.addEventListener("scroll", suivre, true);
    window.addEventListener("resize", suivre);
    return () => {
      window.removeEventListener("scroll", suivre, true);
      window.removeEventListener("resize", suivre);
    };
  }, [ouvert]);

  // Clic hors du popover ET hors du bouton : fermeture. `mousedown` plutôt que
  // `click` pour fermer avant qu'un autre contrôle ne prenne le focus.
  useEffect(() => {
    if (!ouvert) return;
    const dehors = (e: MouseEvent) => {
      const cible = e.target as Node;
      if (popoverRef.current?.contains(cible) || boutonRef.current?.contains(cible)) return;
      setOuvert(false);
      setFiltre(FILTRE_INITIAL);
    };
    document.addEventListener("mousedown", dehors);
    return () => document.removeEventListener("mousedown", dehors);
  }, [ouvert]);

  // L'ouverture positionne la sélection sur le modèle courant : la liste
  // s'ouvre sur « où j'en suis », pas en haut d'un catalogue de 300 entrées.
  useEffect(() => {
    if (!ouvert) return;
    const i = options.indexOf(value);
    setActif(i >= 0 ? i : 0);
    // Volontairement limité à l'ouverture : la frappe recalcule `options` en
    // continu, et repositionner à chaque lettre annulerait la navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ouvert]);

  // Le filtre peut raccourcir la liste sous l'index actif (frappe, puce cochée).
  useEffect(() => {
    setActif((prev) => Math.min(prev, Math.max(0, options.length - 1)));
  }, [options.length]);

  useEffect(() => {
    if (!ouvert) return;
    listeRef.current
      ?.querySelector(`[data-index="${actif}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [actif, ouvert]);

  function choisir(valeur: string) {
    onChange(valeur);
    fermer();
  }

  /*
   * Navigation : portée par le CHAMP de recherche, pas par le popover entier.
   * Sur le conteneur, les flèches captureraient aussi celles du `<select>` de
   * tri et casseraient son propre clavier. Home/End ne sont volontairement PAS
   * détournés : dans un champ texte, ils appartiennent au curseur.
   */
  function clavierRecherche(e: ReactKeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (options.length === 0) return;
      const pas = e.key === "ArrowDown" ? 1 : -1;
      setActif((prev) => (prev + pas + options.length) % options.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const choix = options[actif];
      if (choix !== undefined) choisir(choix);
    }
  }

  /* ---------- État fermé : ce que vaut le choix courant, en une ligne ---------- */

  let libelle: string;
  let details: string | null = null;
  if (epingleCourant) {
    libelle = epingleCourant.label;
  } else if (modeleCourant) {
    libelle = modeleCourant.name ?? modeleCourant.id;
    if (modeleCourant.pricing || modeleCourant.contextLength !== undefined) {
      const prix = estGratuit(modeleCourant) ? "gratuit" : formatPricing(modeleCourant.pricing);
      details = `${prix} · ${formatContext(modeleCourant.contextLength)}`;
    }
  } else {
    libelle = value || "—";
  }

  // Le relevé ne se mentionne que s'il ordonne réellement quelque chose : chez
  // un fournisseur dont aucun éditeur n'y figure (Ollama), c'est du bruit.
  const classementVisible = liste.groupes.some((g) => rangEditeur(g.editeur) !== Infinity);

  let libelleVariantes = "Variantes";
  if (filtre.variantes) {
    libelleVariantes = "Variantes affichées";
  } else if (liste.variantesMasquees > 0) {
    libelleVariantes = `Variantes (${liste.variantesMasquees})`;
  }

  const popover = ouvert && position && (
    <div
      ref={popoverRef}
      className="model-picker__popover"
      role="dialog"
      aria-label="Choisir un modèle"
      // Échap depuis N'IMPORTE OÙ dans le popover (tri, puces), pas seulement
      // depuis le champ de recherche.
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          fermer();
        }
      }}
      style={{
        left: position.left,
        width: position.width,
        ...(position.top !== undefined ? { top: position.top } : { bottom: position.bottom }),
      }}
    >
      <div className="model-picker__barre">
        <input
          type="search"
          autoFocus
          className="model-picker__recherche"
          value={filtre.recherche}
          onChange={(e) => setFiltre((f) => ({ ...f, recherche: e.currentTarget.value }))}
          onKeyDown={clavierRecherche}
          placeholder="Rechercher (nom, id)…"
          aria-label="Rechercher un modèle"
          aria-controls={`${baseId}-liste`}
          aria-activedescendant={options.length > 0 ? `${baseId}-opt-${actif}` : undefined}
        />
        <select
          className="model-picker__tri"
          value={filtre.tri}
          onChange={(e) => setFiltre((f) => ({ ...f, tri: e.currentTarget.value as ModelSortKey }))}
          aria-label="Trier les modèles"
        >
          {MODEL_SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="model-picker__puces">
        <button
          type="button"
          className={`model-chip${filtre.gratuitSeulement ? " model-chip--active" : ""}`}
          aria-pressed={filtre.gratuitSeulement}
          onClick={() => setFiltre((f) => ({ ...f, gratuitSeulement: !f.gratuitSeulement }))}
        >
          Gratuit
        </button>
        {/* Compteur plutôt qu'escamotage : masquer par défaut est un confort,
            le taire serait un mensonge sur ce que contient le catalogue. */}
        <button
          type="button"
          className={`model-chip${filtre.variantes ? " model-chip--active" : ""}`}
          aria-pressed={filtre.variantes}
          onClick={() => setFiltre((f) => ({ ...f, variantes: !f.variantes }))}
          title="Variantes d'un même modèle (:free, :thinking…) masquées tant que le modèle de base est présent"
        >
          {libelleVariantes}
        </button>
      </div>

      <ul ref={listeRef} id={`${baseId}-liste`} className="model-picker__liste" role="listbox">
        {lignes.map((ligne) => {
          if (ligne.type === "entete") {
            // En-tête non pliable (Favoris, catalogue sans éditeur) : simple
            // texte, pas un bouton qui ne ferait rien au clic.
            if (ligne.editeur === null) {
              return (
                <li key={ligne.cle} className="model-picker__entete" role="presentation">
                  {ligne.texte}
                </li>
              );
            }
            const editeur = ligne.editeur;
            return (
              <li key={ligne.cle} role="presentation">
                <button
                  type="button"
                  className="model-picker__entete model-picker__entete--pliable"
                  aria-expanded={ligne.deplie}
                  onClick={() => setChoixPli((prev) => ({ ...prev, [editeur]: !ligne.deplie }))}
                >
                  <span className="model-picker__chevron" aria-hidden="true">
                    {ligne.deplie ? "▾" : "▸"}
                  </span>
                  {ligne.texte}
                </button>
              </li>
            );
          }
          const estActif = ligne.index === actif;
          const classe = `model-picker__option${estActif ? " model-picker__option--actif" : ""}`;
          if (ligne.type === "epingle") {
            return (
              <li
                key={ligne.cle}
                id={`${baseId}-opt-${ligne.index}`}
                data-index={ligne.index}
                className={`${classe} model-picker__option--epingle`}
                role="option"
                aria-selected={ligne.option.value === value}
                title={ligne.option.title}
                onClick={() => choisir(ligne.option.value)}
                onMouseEnter={() => setActif(ligne.index)}
              >
                <span className="model-picker__titre">{ligne.option.label}</span>
              </li>
            );
          }
          const { model } = ligne;
          const suffixe = suffixeVariante(model.id);
          return (
            <li
              key={ligne.cle}
              id={`${baseId}-opt-${ligne.index}`}
              data-index={ligne.index}
              className={classe}
              role="option"
              aria-selected={model.id === value}
              title={model.description || undefined}
              onClick={() => choisir(model.id)}
              onMouseEnter={() => setActif(ligne.index)}
            >
              {onToggleFavori && (
                <button
                  type="button"
                  className={`model-star${ligne.favori ? " model-star--active" : ""}`}
                  aria-label={ligne.favori ? `Retirer ${model.id} des favoris` : `Ajouter ${model.id} aux favoris`}
                  onClick={(e) => {
                    // L'étoile vit DANS l'option : sans ça, épingler choisirait
                    // le modèle et fermerait la liste.
                    e.stopPropagation();
                    onToggleFavori(model.id);
                  }}
                >
                  {ligne.favori ? "★" : "☆"}
                </button>
              )}
              <span className="model-picker__corps">
                <span className="model-picker__titre">
                  {model.name ?? model.id}
                  {suffixe && <span className="model-picker__variante">:{suffixe}</span>}
                </span>
                {/* L'id EST ce qui part au fournisseur : jamais caché derrière le
                    nom commercial — mais pas répété quand il EST déjà le titre
                    (fournisseurs sans métadonnées : Ollama, abonnement Claude). */}
                {model.name && <span className="model-picker__slug">{model.id}</span>}
              </span>
              {/* Rien plutôt que « — / — » : un fournisseur muet ne publie pas
                  ses tarifs, ce n'est pas une colonne à remplir de tirets. */}
              {(model.pricing || model.contextLength !== undefined) && (
                <span className="model-picker__badges">
                  <span
                    className={
                      estGratuit(model) ? "model-picker__prix model-picker__prix--gratuit" : "model-picker__prix"
                    }
                  >
                    {estGratuit(model) ? "gratuit" : formatPricing(model.pricing)}
                  </span>
                  <span className="model-picker__contexte">{formatContext(model.contextLength)}</span>
                </span>
              )}
            </li>
          );
        })}
        {options.length === 0 && lignes.length === 0 && (
          <li className="model-picker__vide" role="presentation">
            {models.length === 0 ? "Aucun modèle chargé pour ce fournisseur." : "Aucun modèle ne correspond."}
          </li>
        )}
      </ul>

      {/* L'ordre des éditeurs n'est pas une évidence : il vient d'un relevé
          daté, et le dire est moins cher que laisser croire à un classement
          maison — ou à une mesure en direct. */}
      {/* Un modèle qui disparaît sans un mot est un mensonge par omission :
          l'écart se DIT, avec sa raison. */}
      {liste.agentsRechercheMasques > 0 && (
        <p className="model-picker__source">
          {liste.agentsRechercheMasques} agent
          {liste.agentsRechercheMasques > 1 ? "s" : ""} à recherche intégrée masqué
          {liste.agentsRechercheMasques > 1 ? "s" : ""} : la recherche web est déjà faite par
          l'application, et la leur échoue par intermittence (T-025).
        </p>
      )}
      {classementVisible && <p className="model-picker__source">{TRAFIC_DISCLAIMER}</p>}
    </div>
  );

  return (
    <>
      <button
        ref={boutonRef}
        id={id}
        type="button"
        className="model-picker__bouton"
        disabled={disabled || chargement}
        aria-haspopup="dialog"
        aria-expanded={ouvert}
        onClick={() => (ouvert ? fermer() : ouvrir())}
        onKeyDown={(e) => {
          if (!ouvert && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            ouvrir();
          }
        }}
      >
        <span className="model-picker__valeur">{chargement ? "Chargement…" : libelle}</span>
        {details && <span className="model-picker__meta">{details}</span>}
        <span className="model-picker__chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {popover && createPortal(popover, document.body)}
    </>
  );
}
