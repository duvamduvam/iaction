/*
 * Liste déroulante de l'application — remplace le `<select>` natif partout.
 *
 * ── Pourquoi pas le `<select>` ─────────────────────────────────────────
 * Sa liste ouverte est dessinée par le système : elle ignore le thème, et
 * aucune règle CSS ne la rattrape. Deroulant reprend le rendu du sélecteur de
 * modèle (classes `model-picker__*`, partagées pour que les deux ne divergent
 * pas) ; ses styles propres, `.deroulant__*`, ne portent que les écarts.
 *
 * ── Même écriture qu'un `<select>` ─────────────────────────────────────
 * Les enfants restent des `<option>` / `<optgroup>`. Seul `onChange` diffère :
 * il reçoit la valeur, il n'y a plus d'événement de champ à lire.
 *
 * Le focus reste sur le bouton (aria-activedescendant) tant qu'il n'y a pas
 * de champ de recherche. Le popover est dans un portail, mais ses événements
 * remontent quand même l'arbre REACT : d'où les `stopPropagation` — sans eux,
 * un clic dans la liste atteindrait les `onClick` des parents, et un Échap
 * fermerait aussi la modale ou le ModelPicker qui contient ce Deroulant.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { conteneurPopover, useAncrePopover, type GabaritPopover } from "./ancrePopover";
import { filtrerOptions, indexSaisie, indexVoisin, lireOptions, optionCourante, type OptionDeroulant } from "./deroulantCalc";

interface DeroulantProps {
  /** Id du bouton déclencheur — cible du `<label htmlFor>`. */
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  "aria-label"?: string;
  /** `<option>` et `<optgroup>`, comme dans un `<select>`. */
  children: ReactNode;
}

const GABARIT: GabaritPopover = { largeurMin: 240, hauteurMax: 340 };
/** À partir de ce nombre d'options, parcourir devient plus lent que chercher. */
const SEUIL_RECHERCHE = 10;
/** Au-delà de ce silence, la frappe repart de zéro (même usage qu'un `<select>`). */
const DELAI_SAISIE_MS = 600;

function premierChoisissable(options: OptionDeroulant[]): number {
  return Math.max(0, options.findIndex((o) => !o.disabled));
}

function consommer(e: ReactKeyboardEvent) {
  e.preventDefault();
  e.stopPropagation();
}

export function Deroulant({
  id,
  value,
  onChange,
  disabled = false,
  title,
  className,
  "aria-label": ariaLabel,
  children,
}: Readonly<DeroulantProps>) {
  const [ouvert, setOuvert] = useState(false);
  const [recherche, setRecherche] = useState("");
  const [actif, setActif] = useState(0);
  const saisie = useRef({ texte: "", instant: 0 });
  const listeRef = useRef<HTMLUListElement>(null);
  const baseId = useId();

  const surDehors = useCallback(() => {
    setOuvert(false);
    setRecherche("");
  }, []);
  const { boutonRef, popoverRef, position, positionner } = useAncrePopover(ouvert, GABARIT, surDehors);

  const options = lireOptions(children);
  const courante = optionCourante(options, value);
  const avecRecherche = options.length >= SEUIL_RECHERCHE;
  const visibles = filtrerOptions(options, recherche);
  // La liste peut raccourcir sous l'index (chargement asynchrone, filtre).
  const actifBorne = Math.min(actif, Math.max(0, visibles.length - 1));
  const idActif = ouvert && visibles.length > 0 ? `${baseId}-opt-${actifBorne}` : undefined;

  const fermer = useCallback(() => {
    surDehors();
    boutonRef.current?.focus();
  }, [surDehors, boutonRef]);

  // Un contrôle qui se désactive (tour lancé) ne garde pas sa liste ouverte.
  useEffect(() => {
    if (disabled) surDehors();
  }, [disabled, surDehors]);

  useEffect(() => {
    if (!ouvert) return;
    listeRef.current?.querySelector(`[data-index="${actifBorne}"]`)?.scrollIntoView({ block: "nearest" });
  }, [actifBorne, ouvert]);

  function allerA(texte: string) {
    const maintenant = Date.now();
    const suite = maintenant - saisie.current.instant < DELAI_SAISIE_MS;
    const cumul = suite ? saisie.current.texte + texte : texte;
    saisie.current = { texte: cumul, instant: maintenant };
    const i = indexSaisie(visibles, cumul, actifBorne);
    if (i >= 0) setActif(i);
  }

  function ouvrir(frappe = "") {
    positionner();
    const courant = courante ? options.indexOf(courante) : premierChoisissable(options);
    if (avecRecherche) {
      // La lettre qui a ouvert la liste amorce la recherche au lieu de se perdre.
      setRecherche(frappe);
      setActif(frappe ? premierChoisissable(filtrerOptions(options, frappe)) : courant);
    } else {
      setRecherche("");
      const i = frappe ? indexSaisie(options, frappe, courant) : -1;
      saisie.current = { texte: frappe, instant: Date.now() };
      setActif(i >= 0 ? i : courant);
    }
    setOuvert(true);
  }

  function choisir(option: OptionDeroulant | undefined) {
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    fermer();
  }

  function clavier(e: ReactKeyboardEvent) {
    // Les combinaisons appartiennent aux raccourcis globaux (raccourcisClavier.ts).
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const frappe = e.key.length === 1 && e.key !== " ";
    if (!ouvert) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " " || frappe) {
        consommer(e);
        ouvrir(frappe ? e.key : "");
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      consommer(e);
      if (visibles.length > 0) setActif(indexVoisin(visibles, actifBorne, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter" || (e.key === " " && !avecRecherche)) {
      consommer(e);
      choisir(visibles[actifBorne]);
    } else if (e.key === "Escape") {
      consommer(e);
      fermer();
    } else if (e.key === "Tab") {
      surDehors();
    } else if (!avecRecherche && e.key === "Home") {
      consommer(e);
      setActif(premierChoisissable(visibles));
    } else if (!avecRecherche && e.key === "End") {
      consommer(e);
      setActif(indexVoisin(visibles, 0, -1));
    } else if (!avecRecherche && frappe) {
      consommer(e);
      allerA(e.key);
    }
  }

  function sourisDansPopover(e: ReactMouseEvent) {
    // Arrêté ici, le `mousedown` n'atteint pas le `document` : un popover
    // parent (tri du ModelPicker) ne prend pas ce clic pour un clic dehors.
    e.stopPropagation();
    // Le focus reste sur le bouton — sauf le champ de recherche, qui le veut.
    if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
  }

  const popover = ouvert && position && (
    <div
      ref={popoverRef}
      className="model-picker__popover deroulant__popover"
      onMouseDown={sourisDansPopover}
      onClick={(e) => e.stopPropagation()}
      style={{
        left: position.left,
        width: position.width,
        maxHeight: position.hauteur,
        ...(position.top !== undefined ? { top: position.top } : { bottom: position.bottom }),
      }}
    >
      {avecRecherche && (
        <input
          type="search"
          autoFocus
          className="model-picker__recherche"
          value={recherche}
          onChange={(e) => {
            const texte = e.currentTarget.value;
            setRecherche(texte);
            setActif(premierChoisissable(filtrerOptions(options, texte)));
          }}
          onKeyDown={clavier}
          placeholder="Rechercher…"
          aria-label="Filtrer la liste"
          aria-controls={`${baseId}-liste`}
          aria-activedescendant={idActif}
        />
      )}
      <ul ref={listeRef} id={`${baseId}-liste`} className="model-picker__liste" role="listbox">
        {visibles.map((option, index) => {
          const nouveauGroupe = option.groupe !== null && option.groupe !== visibles[index - 1]?.groupe;
          const classes = ["model-picker__option"];
          if (index === actifBorne && !option.disabled) classes.push("model-picker__option--actif");
          if (option.disabled) classes.push("deroulant__option--desactivee");
          return [
            nouveauGroupe && (
              <li key={`g-${index}`} className="model-picker__entete" role="presentation">
                {option.groupe}
              </li>
            ),
            <li
              key={`o-${index}`}
              id={`${baseId}-opt-${index}`}
              data-index={index}
              className={classes.join(" ")}
              role="option"
              aria-selected={option === courante}
              aria-disabled={option.disabled || undefined}
              title={option.title ?? option.label}
              onClick={() => choisir(option)}
              onMouseEnter={() => setActif(index)}
            >
              <span className="model-picker__titre">{option.label}</span>
            </li>,
          ];
        })}
        {visibles.length === 0 && (
          <li className="model-picker__vide" role="presentation">
            {options.length === 0 ? "Liste vide." : "Aucun résultat."}
          </li>
        )}
      </ul>
    </div>
  );

  return (
    <>
      <button
        ref={boutonRef}
        id={id}
        type="button"
        role="combobox"
        className={`model-picker__bouton deroulant__bouton${className ? ` ${className}` : ""}`}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={ouvert}
        aria-controls={ouvert ? `${baseId}-liste` : undefined}
        aria-activedescendant={avecRecherche ? undefined : idActif}
        onClick={() => (ouvert ? fermer() : ouvrir())}
        onKeyDown={clavier}
      >
        <span className="model-picker__valeur">{courante?.label ?? "—"}</span>
        <span className="model-picker__chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {popover && createPortal(popover, conteneurPopover(boutonRef.current))}
    </>
  );
}
