/*
 * T-191 — compte Claude affiché par la page Supervision. Logique pure : le
 * sélecteur « Perso / Teams » n'existe que si `claude.comptes` rend un compte
 * `teams` ; le choix part dans `usage.stats` (paramètre `compte`, `perso` par
 * défaut côté sidecar — docs/protocol.md).
 */
import { libelleCompte, secondCompteDispo, type CompteClaude, type CompteDecrit } from "./comptesClaude";

/**
 * Compte réellement interrogé : un choix `teams` dont le compte n'est plus listé
 * (identifiants retirés, liste pas encore rendue) retombe sur `perso`, jamais
 * sur une requête que le sidecar refuserait.
 */
export function compteEffectif(choisi: CompteClaude, comptes: readonly CompteDecrit[] | null): CompteClaude {
  return choisi === "teams" && secondCompteDispo(comptes) ? "teams" : "perso";
}

/** Nom du compte à afficher dans la page, ou `null` pour perso (la page reste telle qu'avant). */
export function nomCompteAffiche(compte: CompteClaude, comptes: readonly CompteDecrit[] | null): string | null {
  if (compte === "perso") return null;
  return comptes?.find((c) => c.id === compte)?.label ?? libelleCompte(compte);
}

/** Libellé sous « Débord du mois » : le plafond ne compte QUE le compte perso. */
export function libelleDebord(plafondLabel: string): string {
  return `${plafondLabel} · routage auto, compte perso seulement`;
}
