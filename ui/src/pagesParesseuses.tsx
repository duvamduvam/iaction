/*
 * Les six pages de l'application, et la règle qui décide QUAND chacune entre
 * en mémoire (T-029).
 *
 * ── Le constat ──────────────────────────────────────────────────────────
 * Mesure du 2026-08-11 : au démarrage, la webview charge 7 Mo de JavaScript
 * en 119 modules — 1 264 ms rien qu'à les récupérer et les analyser, sur les
 * 3,0 s que met l'application à afficher sa première image. Or les six pages
 * étaient toutes importées par `App.tsx`, donc toutes chargées, alors qu'une
 * seule est visible : `ProvidersPage` (465 Ko), `ChatPage` (333 Ko),
 * `SystemPage` (173 Ko) et leurs dépendances exclusives étaient payées
 * comptant par quelqu'un qui ouvre l'application sur ses projets.
 *
 * ── La règle ────────────────────────────────────────────────────────────
 * Une page se charge à sa PREMIÈRE visite, et **ne se démonte plus jamais**
 * ensuite. Le second point n'est pas un détail d'optimisation, c'est le
 * contrat que respectait déjà `App.tsx` en gardant les six pages montées :
 * démonter une page perdrait la conversation en cours, un streaming, les logs
 * chargés. On ne retarde donc que la PREMIÈRE mise en mémoire — jamais l'état
 * de quoi que ce soit qui a déjà servi.
 *
 * `AgentPage` (« Projets ») fait exception et reste importée d'emblée : c'est
 * la page ouverte au démarrage, la charger paresseusement ne ferait que
 * déplacer son coût derrière une image vide.
 */
import { lazy, Suspense, useState, type ReactNode } from "react";

/**
 * Chaque page est un export NOMMÉ ; `lazy` attend un module dont l'export par
 * défaut est le composant, d'où la petite conversion. Le `import()` n'est
 * évalué qu'au premier rendu effectif du composant — créer l'élément JSX,
 * comme le fait `App.tsx` pour une page jamais visitée, ne déclenche rien.
 */
export const ChatPage = lazy(() => import("./ChatPage").then((m) => ({ default: m.ChatPage })));
export const OrchestrationPage = lazy(() =>
  import("./OrchestrationPage").then((m) => ({ default: m.OrchestrationPage })),
);
export const ProvidersPage = lazy(() => import("./ProvidersPage").then((m) => ({ default: m.ProvidersPage })));
export const SupervisionPage = lazy(() => import("./SupervisionPage").then((m) => ({ default: m.SupervisionPage })));
export const SystemPage = lazy(() => import("./SystemPage").then((m) => ({ default: m.SystemPage })));

/** Classe du conteneur d'une page : visible, ou masquée sans être démontée. */
export function slotClass(active: boolean): string {
  return active ? "page-slot" : "page-slot page-slot--hidden";
}

/**
 * Une page reste montée dès qu'elle l'a été une fois. Fonction séparée pour
 * que l'invariant se lise et se teste : `monter(true, false)` DOIT valoir
 * `true`, sans quoi quitter un onglet détruirait ce qu'il contient.
 */
export function monter(dejaMontee: boolean, active: boolean): boolean {
  return dejaMontee || active;
}

/**
 * Conteneur d'une page : rien tant qu'elle n'a jamais été demandée, puis le
 * slot habituel, masqué ou visible.
 *
 * L'état vit ICI, un par slot, plutôt que dans un registre commun côté
 * `App.tsx` : une page n'a besoin de connaître que sa propre histoire, et
 * `App.tsx` est déjà bien assez gros (cliquet à 1 266 lignes).
 */
export function SlotPage({ active, children }: { active: boolean; children: ReactNode }): ReactNode {
  const [dejaMontee, setDejaMontee] = useState(active);
  // Mise à jour d'état PENDANT le rendu : le cas prévu par React (« ajuster
  // l'état sur un changement de props »), qui relance le rendu du composant
  // avant de peindre. Un `useEffect` afficherait une image vide de plus.
  if (monter(dejaMontee, active) !== dejaMontee) setDejaMontee(true);
  if (!monter(dejaMontee, active)) return null;

  return (
    <div className={slotClass(active)}>
      {/* Le repli n'est visible qu'une fraction de seconde (import local),
          mais il existe : une page qui met du temps à venir doit le DIRE
          plutôt que de laisser un rectangle vide sans explication. */}
      <Suspense fallback={<p className="page-chargement">Chargement de la page…</p>}>{children}</Suspense>
    </div>
  );
}
