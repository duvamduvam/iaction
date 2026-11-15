/*
 * Décisions de Deroulant.tsx, testées sans fenêtre : lecture des `<option>`,
 * filtre, navigation clavier. Le composant ne fait que du DOM et du focus.
 */
import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { fuzzyScore } from "./fuzzy";

export interface OptionDeroulant {
  value: string;
  label: string;
  title?: string;
  disabled: boolean;
  /** Libellé de l'`<optgroup>` englobant, `null` hors groupe. */
  groupe: string | null;
}

interface ProprietesOption {
  value?: string | number;
  label?: string;
  title?: string;
  disabled?: boolean;
  children?: ReactNode;
}

function texteDe(noeud: ReactNode): string {
  return Children.toArray(noeud)
    .map((n) => (isValidElement(n) ? texteDe((n.props as ProprietesOption).children) : String(n)))
    .join("");
}

/**
 * Traduit les enfants d'un `<Deroulant>` — les mêmes `<option>` / `<optgroup>`
 * que ceux d'un `<select>`, tableaux, conditions et fragments compris.
 */
export function lireOptions(enfants: ReactNode, groupe: string | null = null): OptionDeroulant[] {
  return Children.toArray(enfants).flatMap((enfant) => {
    if (!isValidElement(enfant)) return [];
    const { type, props } = enfant as ReactElement<ProprietesOption>;
    if (type === Fragment) return lireOptions(props.children, groupe);
    if (type === "optgroup") return lireOptions(props.children, props.label ?? null);
    if (type !== "option") return [];
    const label = texteDe(props.children);
    return [
      {
        // Comme le HTML : une option sans `value` vaut son texte.
        value: String(props.value ?? label),
        label,
        title: props.title,
        disabled: props.disabled === true,
        groupe,
      },
    ];
  });
}

/**
 * Option à afficher fermé. Une valeur absente de la liste montre la première
 * option disponible : c'est ce que fait un `<select>` contrôlé par React, et
 * plusieurs écrans comptent dessus le temps que leur liste se charge.
 */
export function optionCourante(options: OptionDeroulant[], valeur: string): OptionDeroulant | null {
  return options.find((o) => o.value === valeur) ?? options.find((o) => !o.disabled) ?? null;
}

export function filtrerOptions(options: OptionDeroulant[], recherche: string): OptionDeroulant[] {
  const q = recherche.trim();
  if (!q) return options;
  return options.filter((o) => fuzzyScore(`${o.label} ${o.value}`, q) !== null);
}

/** Index suivant dans le sens `pas`, en bouclant et en sautant les options désactivées. */
export function indexVoisin(options: OptionDeroulant[], depuis: number, pas: 1 | -1): number {
  const n = options.length;
  for (let i = 1; i <= n; i++) {
    const candidat = (depuis + pas * i + n * (i + 1)) % n;
    if (!options[candidat].disabled) return candidat;
  }
  return depuis;
}

const sansAccent = (texte: string) =>
  texte
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/**
 * Saisie au clavier sur une liste sans champ de recherche. Une seule lettre
 * part de l'option SUIVANTE (taper « g » deux fois passe au deuxième « g… »),
 * plusieurs lettres affinent l'option en cours. -1 si rien ne correspond.
 */
export function indexSaisie(options: OptionDeroulant[], saisie: string, depuis: number): number {
  const prefixe = sansAccent(saisie);
  const n = options.length;
  const decalage = prefixe.length === 1 ? 1 : 0;
  for (let i = 0; i < n; i++) {
    const candidat = (depuis + decalage + i + n) % n;
    const option = options[candidat];
    if (!option.disabled && sansAccent(option.label).startsWith(prefixe)) return candidat;
  }
  return -1;
}
