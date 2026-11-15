/*
 * Menu « / » du composeur de la page Projets — la logique pure (détection du
 * token sous le curseur, filtrage des commandes, insertion). Sortie
 * d'AgentPage.tsx (T-209) ; l'état du menu et le brouillon restent à la page.
 */
import type { SlashCommandInfo } from "./commandesSlash";

export interface EtatMenuSlash {
  open: boolean;
  fragment: string;
  start: number;
  selected: number;
}

/**
 * Détecte un token « /frag » sous le curseur, SEULEMENT s'il démarre la
 * ligne courante (début du texte ou juste après un saut de ligne) — un
 * « / » au milieu d'un mot (ex. « et/ou ») ne matche jamais. Le fragment ne
 * doit contenir ni espace ni saut de ligne (dès qu'un espace suit le nom de
 * la commande, on considère que l'utilisateur tape ses arguments : plus de
 * détection).
 */
export function detectSlashToken(text: string, cursor: number): { start: number; fragment: string } | null {
  const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
  if (text[lineStart] !== "/") return null;
  const token = text.slice(lineStart, cursor);
  if (!/^\/\S*$/.test(token)) return null;
  return { start: lineStart, fragment: token.slice(1) };
}

/** Commandes dont le nom OU un alias matche `fragment` — préfixe prioritaire, puis sous-chaîne, insensible à la casse. */
export function matchSlashCommands(commands: SlashCommandInfo[], fragment: string): SlashCommandInfo[] {
  const needle = fragment.toLowerCase();
  const prefix: SlashCommandInfo[] = [];
  const substring: SlashCommandInfo[] = [];
  for (const cmd of commands) {
    const names = [cmd.name, ...(cmd.aliases ?? [])].map((n) => n.toLowerCase());
    if (names.some((n) => n.startsWith(needle))) prefix.push(cmd);
    else if (names.some((n) => n.includes(needle))) substring.push(cmd);
  }
  return [...prefix, ...substring];
}

/** État du menu fermé — même objet s'il l'est déjà (pas de rendu inutile). */
export function menuFerme(m: EtatMenuSlash): EtatMenuSlash {
  return m.open ? { ...m, open: false } : m;
}

/**
 * Prochain état du menu après une frappe : ouvert sur le token détecté s'il
 * reste au moins une commande qui lui correspond, fermé sinon.
 */
export function menuApresFrappe(
  menu: EtatMenuSlash,
  commands: SlashCommandInfo[],
  text: string,
  cursor: number,
): EtatMenuSlash {
  const token = detectSlashToken(text, cursor);
  if (!token || commands.length === 0 || matchSlashCommands(commands, token.fragment).length === 0) return menuFerme(menu);
  return { open: true, fragment: token.fragment, start: token.start, selected: 0 };
}

/** Remplace le fragment « /frag » courant par « /name » + espace ; rend le texte et la position du curseur juste après l'espace. */
export function insererCommandeSlash(
  brouillon: string,
  menu: Pick<EtatMenuSlash, "start" | "fragment">,
  cmd: SlashCommandInfo,
): { texte: string; curseur: number } {
  const insertion = `/${cmd.name} `;
  const avant = brouillon.slice(0, menu.start);
  const apres = brouillon.slice(menu.start + 1 + menu.fragment.length);
  return { texte: `${avant}${insertion}${apres}`, curseur: avant.length + insertion.length };
}
