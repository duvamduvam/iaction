/*
 * Navigation au clavier entre les grandes zones : cycle F6 (façon VS Code) et
 * déplacement DIRECTIONNEL Alt + flèches.
 *
 * Sorti d'App.tsx le 2026-08-15. Ce n'est pas un rangement de confort : ces
 * ~240 lignes ne touchent ni à l'état de l'application, ni à React — elles
 * lisent le DOM et déplacent le focus. Les garder au milieu du composant
 * racine, c'était rendre l'un et l'autre plus difficiles à lire, et le cliquet
 * de taille a fini par poser la question (T-008).
 */

import type { PageId } from "./navigation";


/*
 * Table des zones par page : sélecteurs des grands conteneurs EXISTANTS de
 * chaque page (aucune classe ajoutée). Chaque sélecteur peut désigner
 * PLUSIEURS éléments (toutes les sections d'une sidebar, par exemple) ; les
 * zones retenues sont ensuite ordonnées dans l'ordre du document, de sorte que
 * le cycle F6 descende la page. La nav d'en-tête (`.app-nav`) est toujours la
 * première zone ; les sélecteurs ci-dessous sont résolus dans le seul slot
 * visible (les six pages restent montées, masquées via `.page-slot--hidden`,
 * voir slotClass).
 */
const PAGE_ZONES: Record<PageId, string[]> = {
  // Granularité : une sidebar entière ferait une zone unique dont on n'atteint
  // que le premier champ, tout ce qui suit restant hors du cycle — d'où une
  // zone par SECTION dépliante. Les collections (`.file-tree__body` role=tree,
  // `.session-list`) restent des zones à part entière, imbriquées dans leur
  // section : on y atterrit sur l'item courant (roving tabindex) plutôt que sur
  // l'en-tête de section ou le bouton « Nouvelle… » qui la précède.
  projects: [
    ".sidebar-section",
    ".file-tree__body",
    ".agent-main__content",
    ".chat-composer",
    ".session-list",
  ],
  chat: [".sidebar-section", ".session-list", ".chat-log", ".chat-composer"],
  orchestration: [".orch-header-row", ".orch-panel:not(.orch-panel--hidden)"],
  supervision: [".supervision-toolbar", ".panels"],
  config: [".config-subnav", ".config-panel:not(.config-panel--hidden)"],
  // L3 — le panneau « Journal » est une zone, et sa liste d'entrées en est une
  // autre (roving tabindex) : on y atterrit sur l'entrée courante sans
  // traverser chips et filtres un à un. Même principe que `.session-list`.
  // TK1 — le panneau « Tickets » suit la même découpe (panneau + liste), au
  // rang qu'il occupe à l'écran : juste après le journal.
  system: [
    ".journal-panel",
    ".journal-list",
    ".tickets-panel",
    ".tickets-list",
    ".panels",
    ".logs-panel",
  ],
};

const FOCUSABLE_SELECTOR =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Zones effectivement présentes à l'écran : nav d'en-tête + zones du slot actif. */
function collectZones(page: PageId): HTMLElement[] {
  const zones: HTMLElement[] = [];
  const nav = document.querySelector<HTMLElement>(".app-nav");
  if (nav) zones.push(nav);
  const slot = document.querySelector<HTMLElement>(".page-slot:not(.page-slot--hidden)");
  if (slot) {
    const found = new Set<HTMLElement>();
    for (const sel of PAGE_ZONES[page]) {
      for (const el of slot.querySelectorAll<HTMLElement>(sel)) found.add(el);
    }
    // Ordre du document (un ancêtre précède ses descendants) : le cycle F6 suit
    // la page de haut en bas, quel que soit l'ordre des sélecteurs déclarés.
    const ordered = [...found].sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    zones.push(...ordered);
  }
  return zones;
}

function firstFocusable(zone: HTMLElement): HTMLElement | null {
  for (const el of zone.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    if (el.offsetParent === null) continue; // écarte les éléments masqués (display:none…)
    // Sorti de l'ordre de tabulation (roving tabindex des menus, listes,
    // onglets, arbre) : on entre la zone par son item courant, pas par le premier.
    if (el.getAttribute("tabindex") === "-1") continue;
    return el;
  }
  return null;
}

/** Zone réellement à l'écran : ni masquée, ni réduite à un rectangle vide. */
function isZoneVisible(zone: HTMLElement): boolean {
  if (zone.offsetParent === null) return false;
  const rect = zone.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

/**
 * Pose le focus dans une zone et dit s'il a bougé. Zone sans élément
 * focusable (fil de conversation, page de doc, logs…) : on focalise la RÉGION
 * elle-même — `tabIndex=-1` posé à la volée (technique des « skip links », le
 * JSX des pages reste intact), ce qui la rend atteignable puis parcourable
 * aux flèches / Page haut / Page bas.
 */
function focusZone(zone: HTMLElement): boolean {
  if (!isZoneVisible(zone)) return false;
  const target = firstFocusable(zone);
  if (target) {
    target.focus();
    return true;
  }
  if (!zone.hasAttribute("tabindex")) {
    zone.tabIndex = -1;
    zone.classList.add("zone-focusable"); // liseré rentré, voir App.css
  }
  zone.focus();
  return true;
}

/**
 * Zone contenant le focus, ou -1. Les zones peuvent être imbriquées (le
 * composeur vit dans le contenu principal) : on retient la PLUS PROFONDE.
 */
function activeZoneIndex(zones: HTMLElement[]): number {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return -1;
  let current = -1;
  for (let i = 0; i < zones.length; i++) {
    if (zones[i].contains(active) && (current === -1 || zones[current].contains(zones[i]))) current = i;
  }
  return current;
}

/**
 * F6 / Shift+F6 : focus sur la zone suivante / précédente (cycle) — son
 * premier élément focusable, ou la zone elle-même si elle n'en a aucun. Seule
 * une zone masquée est sautée ; sans zone courante, F6 part de la première,
 * Shift+F6 de la dernière.
 */
function cycleFocusZone(page: PageId, backwards: boolean) {
  const zones = collectZones(page);
  if (zones.length === 0) return;
  const current = activeZoneIndex(zones);
  const len = zones.length;
  const step = backwards ? -1 : 1;
  const start = current === -1 ? (backwards ? len : -1) : current;
  for (let n = 1; n <= len; n++) {
    const idx = (((start + step * n) % len) + len) % len;
    if (focusZone(zones[idx])) return;
  }
}

/**
 * Garde F6 de l'écouteur global : `true` si la touche était F6 (traitée ou
 * volontairement ignorée — modale <dialog> ouverte, le focus doit rester
 * piégé dedans).
 */
export function handleFocusCycleKey(e: KeyboardEvent, page: PageId): boolean {
  if (e.key !== "F6" || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (!document.querySelector("dialog[open]")) {
    e.preventDefault();
    cycleFocusZone(page, e.shiftKey);
  }
  return true;
}

/* ---------- Alt + flèches : déplacement DIRECTIONNEL entre les zones ---------- */

type ZoneDirection = "left" | "right" | "up" | "down";

const ARROW_DIRECTIONS: Record<string, ZoneDirection> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/** Écart minimal (px) entre centres pour considérer une zone « dans la direction ». */
const ZONE_DIRECTION_MARGIN = 8;
/** Pénalité de l'axe perpendiculaire (navigation spatiale classique). */
const ZONE_CROSS_PENALTY = 2;

/**
 * Coût du saut `from` → `rect` dans la direction demandée : distance des
 * centres le long de l'axe, pénalisée sur l'axe perpendiculaire. `Infinity`
 * quand la zone n'est pas du bon côté (ou n'a aucune surface à l'écran).
 */
function zoneDirectionScore(from: DOMRect, rect: DOMRect, direction: ZoneDirection): number {
  if (rect.width === 0 && rect.height === 0) return Infinity;
  const horizontal = direction === "left" || direction === "right";
  const dx = (rect.left + rect.right - from.left - from.right) / 2;
  const dy = (rect.top + rect.bottom - from.top - from.bottom) / 2;
  const along = horizontal ? dx : dy;
  const across = horizontal ? dy : dx;
  const signed = direction === "right" || direction === "down" ? along : -along;
  if (signed < ZONE_DIRECTION_MARGIN) return Infinity;
  return Math.abs(along) + ZONE_CROSS_PENALTY * Math.abs(across);
}

/**
 * Focus sur la zone voisine dans la direction demandée : parmi les zones
 * visibles dont le centre est bien de ce côté, la mieux notée. `true` si le
 * focus a effectivement bougé.
 */
function moveFocusZone(page: PageId, direction: ZoneDirection): boolean {
  const zones = collectZones(page);
  if (zones.length === 0) return false;
  const current = activeZoneIndex(zones);
  // Focus hors de toute zone (<body>, au démarrage ou après un clic dans le
  // vide) : on entre par la première zone plutôt que d'abandonner, comme F6.
  if (current === -1) return focusZone(zones[0]);
  const from = zones[current].getBoundingClientRect();
  // Zones IMBRIQUÉES (l'arbre dans la sidebar gauche, le composeur dans le
  // contenu principal) : leurs rectangles se recouvrent, comparer les centres
  // des deux zones ne dit rien de la direction. On part alors du rectangle de
  // l'élément focusé — Alt+↓ depuis le haut de la sidebar atteint bien l'arbre.
  const active = document.activeElement;
  const fromActive = active instanceof HTMLElement ? active.getBoundingClientRect() : from;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < zones.length; i++) {
    if (i === current || !isZoneVisible(zones[i])) continue;
    const nested = zones[current].contains(zones[i]) || zones[i].contains(zones[current]);
    const score = zoneDirectionScore(nested ? fromActive : from, zones[i].getBoundingClientRect(), direction);
    if (score >= bestScore) continue;
    best = zones[i];
    bestScore = score;
  }
  return best !== null && focusZone(best);
}

/**
 * Garde Alt+flèche : `true` si le focus a effectivement changé de zone (seul
 * cas où l'événement est consommé). Alt SEUL + flèche (ni Ctrl, ni Meta, ni
 * Maj — Maj+flèche reste la sélection de texte native), et inerte sous modale.
 *
 * Le raccourci vaut PARTOUT, y compris dans les champs de saisie et l'éditeur
 * de code : c'est tout l'intérêt d'Alt, qui ne sert à rien dans la sélection
 * de texte. D'où l'écoute en phase de CAPTURE (voir l'effet plus bas).
 */
export function handleZoneArrowKey(e: KeyboardEvent, page: PageId): boolean {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  const direction = ARROW_DIRECTIONS[e.key];
  if (!direction) return false;
  if (document.querySelector("dialog[open]")) return false;
  if (!moveFocusZone(page, direction)) return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}
