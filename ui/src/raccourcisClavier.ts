/*
 * Tableau des raccourcis clavier affiché en Configuration → Clavier.
 *
 * Donnée pure, sortie de ProvidersPage.tsx le 2026-08-15 : 240 lignes de
 * documentation au milieu d'un fichier de 3 200 qui, lui, fait tourner les
 * fournisseurs, les modèles, la voix et les applications. Elles n'ont aucun
 * rapport avec le reste, et c'est le cliquet de taille qui a posé la question
 * en refusant l'encart « Réseau » (T-045). Il avait raison.
 *
 * Sources tenues à jour à la main : écouteur global et cycle F6 dans App.tsx et
 * focusZones.ts, useRovingFocus.ts (listes/onglets), FileTree.tsx (arbre),
 * Modal.tsx (<dialog>), composeurs d'AgentPage/ChatPage, CommandPalette.tsx.
 */

export interface ShortcutRow {
  /** Combinaisons équivalentes ou symétriques, séparées par « / » à l'affichage (ex. ↑ / ↓). */
  combos: string[][];
  action: string;
  note?: string;
}

export interface ShortcutGroup {
  title: string;
  intro: string;
  rows: ShortcutRow[];
}

/**
 * Toute la navigation clavier, par thème. Sources : écouteur global et cycle
 * F6 dans App.tsx, useRovingFocus.ts (listes/onglets), FileTree.tsx (arbre),
 * Modal.tsx (<dialog>), composeurs d'AgentPage/ChatPage, CommandPalette.tsx.
 */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Navigation globale",
    intro:
      "Raccourcis actifs partout, même pendant la frappe d'un message. Ctrl+N et Ctrl+K restent sans effet tant qu'une réponse est en cours d'écriture.",
    rows: [
      {
        combos: [["Ctrl", "1"]],
        action: "Aller à une page par son numéro (1 à 6)",
        note: "Ctrl+1 Projets · 2 Chat · 3 Orchestration · 4 Supervision · 5 Configuration · 6 Système. Fonctionne au pavé numérique comme à la rangée de chiffres, verrouillage numérique éteint compris.",
      },
      { combos: [["Ctrl", "P"]], action: "Aller à la page Projets" },
      { combos: [["Ctrl", "H"]], action: "Aller à la page Chat" },
      {
        combos: [["Ctrl", "N"]],
        action: "Nouvelle conversation",
        note: "Pages Projets et Chat : ouvre une nouvelle conversation dans un ONGLET supplémentaire, les conversations déjà ouvertes le restent (même action que le bouton « + » de la barre d'onglets).",
      },
      {
        combos: [
          ["Ctrl", "Tab"],
          ["Ctrl", "Maj", "Tab"],
        ],
        action: "Conversation suivante / précédente",
        note: "Pages Projets et Chat : fait défiler les onglets de conversation ouverts. Une conversation dont l'onglet n'est pas affiché continue de travailler — un point cyan sur son onglet signale qu'un tour est en cours.",
      },
      {
        combos: [["Ctrl", "Suppr"]],
        action: "Fermer l'onglet de conversation",
        note: "Pages Projets et Chat. L'HISTORIQUE EST CONSERVÉ : la conversation reste dans le panneau latéral (« Sessions »/« Historique ») et se rouvre d'un clic. Sa suppression définitive n'est possible que depuis ce panneau, avec confirmation. Refusé tant qu'un tour est en cours (un message l'indique) : arrêtez-le d'abord.",
      },
      {
        combos: [["Ctrl", "K"]],
        action: "Vider la conversation en cours",
        note: "Efface les messages de la session affichée (elle garde son nom, sa configuration et son id). Un bandeau « Annuler » permet de revenir en arrière juste après.",
      },
      {
        combos: [["Ctrl", "L"]],
        action: "Placer le curseur dans la zone de saisie",
        note: "Pages Projets et Chat. Le curseur y est déjà placé automatiquement à l'arrivée sur la page, après un vidage et après une nouvelle conversation.",
      },
      {
        combos: [["Ctrl", "S"]],
        action: "Enregistrer le fichier en cours d'édition",
        note: "Page Projets, quand un onglet de fichier est actif.",
      },
      {
        combos: [["Ctrl", "T"]],
        action: "Ouvrir un terminal",
        note: "Dans le répertoire du projet en cours si la page Projets est active, sinon dans le dossier personnel.",
      },
      {
        combos: [["Ctrl", "Maj", "P"]],
        action: "Ouvrir la palette de bascule de projet",
        note: "Voir la section « Palette de projet » ci-dessous.",
      },
    ],
  },
  {
    title: "Zones (F6 et Alt+flèches)",
    intro:
      "Deux façons de passer d'une zone de la page à l'autre. Une zone, c'est la navigation d'en-tête, chaque section dépliante des barres latérales (« LLM », « Historique », « Projet », « Fichiers », « Sessions »…), les collections qu'elles contiennent (liste de conversations, arborescence de fichiers), le fil de conversation, la zone de saisie et les panneaux de contenu. Une section repliée reste une zone : son en-tête reçoit le focus, Entrée la déplie. F6 est un parcours séquentiel cyclique ; Alt+flèche va directement au panneau voisin dans la direction indiquée. Alt+flèche fonctionne partout, y compris depuis un champ de texte ou l'éditeur de code — Alt ne servant pas à la sélection, le raccourci n'a rien à voler à la frappe. Une zone de lecture seule (fil de conversation, cette page de documentation, logs) reçoit le focus en tant que telle : les flèches, Page haut et Page bas la font alors défiler. Le découpage en zones s'adapte à la page affichée. Quand une modale est ouverte, ces raccourcis sont sans effet : le focus lui reste réservé.",
    rows: [
      {
        combos: [["F6"]],
        action: "Zone suivante",
        note: "Le parcours suit la page de haut en bas, de gauche à droite. Le focus se pose sur le premier élément de la zone, ou sur la zone elle-même quand elle n'en contient aucun.",
      },
      { combos: [["Maj", "F6"]], action: "Zone précédente" },
      {
        combos: [["F6"], ["Alt", "↓"]],
        action: "Atteindre la liste des conversations",
        note: "Page Chat : la section « Historique » est une zone, et la liste elle-même en est une autre — le focus s'y pose sur la conversation courante, sans traverser la section « LLM » champ par champ. Même principe pour « Sessions » sur la page Projets.",
      },
      {
        combos: [["F6"], ["Alt", "↓"]],
        action: "Atteindre l'arborescence de fichiers",
        note: "Page Projets : l'arborescence est une zone à part entière, atteinte directement sans traverser le reste de la barre latérale gauche. Le focus s'y pose sur le dernier élément parcouru ; le bouton « Rafraîchir » reste accessible par Maj+Tab. Section « Fichiers » repliée : la zone est simplement sautée.",
      },
      {
        combos: [
          ["Alt", "←"],
          ["Alt", "→"],
        ],
        action: "Zone voisine à gauche / à droite",
        note: "La zone retenue est la plus proche dans cette direction ; sans voisine de ce côté, rien ne bouge. Hors de toute zone, le focus entre par la première.",
      },
      {
        combos: [
          ["Alt", "↑"],
          ["Alt", "↓"],
        ],
        action: "Zone voisine au-dessus / en dessous",
      },
    ],
  },
  {
    title: "Listes, onglets et arborescence",
    intro:
      "Chaque collection (liste de sessions, onglets de fichiers, arborescence) ne compte qu'un seul arrêt de tabulation : Tab y entre puis en sort, les flèches se déplacent à l'intérieur.",
    rows: [
      {
        combos: [["↑"], ["↓"]],
        action: "Élément précédent / suivant",
        note: "Listes de sessions et arborescence de fichiers.",
      },
      {
        combos: [["←"], ["→"]],
        action: "Onglet précédent / suivant",
        note: "Onglets de fichiers ouverts (page Projets).",
      },
      { combos: [["Début"], ["Fin"]], action: "Premier / dernier élément" },
      {
        combos: [["→"]],
        action: "Ouvrir le dossier, puis descendre à son premier enfant",
        note: "Arborescence de fichiers.",
      },
      {
        combos: [["←"]],
        action: "Refermer le dossier, ou remonter au dossier parent",
        note: "Arborescence de fichiers.",
      },
      {
        combos: [["Entrée"]],
        action: "Ouvrir l'élément focusé",
        note: "Ouvre la session ou le fichier, active l'onglet (Espace fonctionne aussi sur les onglets et dans l'arborescence). Dans une liste de sessions, Tab atteint ensuite les boutons Renommer et Supprimer de la session focusée.",
      },
    ],
  },
  {
    title: "Menus",
    intro:
      "La barre principale des six pages et les sous-menus (Configuration, Orchestration, granularité de Supervision) se parcourent aux flèches. Le déplacement au clavier ne change PAS de page ni d'onglet : il faut valider avec Entrée ou Espace. Comme pour les autres collections, un seul arrêt de tabulation — l'élément actif — donc Tab traverse le menu au lieu de s'y arrêter six fois. Le bouton « Terminal » fait partie du parcours de la barre principale.",
    rows: [
      { combos: [["←"], ["→"]], action: "Élément de menu précédent / suivant", note: "Le parcours est circulaire." },
      { combos: [["Début"], ["Fin"]], action: "Premier / dernier élément du menu" },
      {
        combos: [["Entrée"], ["Espace"]],
        action: "Activer l'élément focusé",
        note: "Seule façon de changer de page ou d'onglet au clavier depuis un menu. Ctrl+1 à Ctrl+6 restent le raccourci direct vers une page.",
      },
    ],
  },
  {
    title: "Modales",
    intro:
      "Toutes les modales (formulaires d'orchestration, aperçu de pièce jointe…) gardent le focus pour elles : le reste de la page est inerte.",
    rows: [
      {
        combos: [["Échap"]],
        action: "Fermer la modale",
        note: "Le focus revient à l'élément qui l'avait ouverte.",
      },
      { combos: [["Tab"], ["Maj", "Tab"]], action: "Circuler entre les éléments, confiné à la modale" },
    ],
  },
  {
    title: "Zone de saisie",
    intro: "Dans le composeur des pages Projets et Chat.",
    rows: [
      { combos: [["Entrée"]], action: "Envoyer le message" },
      { combos: [["Maj", "Entrée"]], action: "Saut de ligne" },
      {
        combos: [["Ctrl", "Z"]],
        action: "Annuler la dernière modification",
        note: "Historique propre au composeur, conversation par conversation : la frappe est annulée par petits blocs, et les insertions automatiques (dictée vocale, vidage à l'envoi…) sont annulables aussi.",
      },
      {
        combos: [
          ["Ctrl", "Maj", "Z"],
          ["Ctrl", "Y"],
        ],
        action: "Rétablir la modification annulée",
      },
      {
        combos: [["/"]],
        action: "Ouvrir le menu des commandes",
        note: "En début de ligne, dans le composeur de la page Projets.",
      },
      { combos: [["↑"], ["↓"]], action: "Naviguer dans le menu des commandes" },
      { combos: [["Entrée"], ["Tab"]], action: "Insérer la commande sélectionnée" },
      { combos: [["Échap"]], action: "Fermer le menu des commandes" },
    ],
  },
  {
    title: "Palette de projet",
    intro:
      "Ctrl+Maj+P ouvre, depuis n'importe quelle page, une palette de recherche pour basculer d'un projet à l'autre ; taper filtre la liste.",
    rows: [
      { combos: [["Ctrl", "Maj", "P"]], action: "Ouvrir ou fermer la palette" },
      { combos: [["↑"], ["↓"]], action: "Projet précédent / suivant" },
      {
        combos: [["Entrée"]],
        action: "Basculer vers le projet sélectionné",
        note: "Ouvre la page Projets. Refusé si un run est en cours (un message l'indique).",
      },
      { combos: [["Échap"]], action: "Fermer la palette" },
    ],
  },
];
