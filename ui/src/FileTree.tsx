/*
 * Panneau latéral gauche (page Agent) : arborescence du dossier projet
 * courant, chargement paresseux (`fs_list_dir` au dépliage), repliable.
 * Le tri est déjà fait côté Rust (dossiers d'abord, puis alphabétique) : on
 * affiche tel quel.
 *
 * Clic droit sur un FICHIER (Lot 5) : menu contextuel — « Ouvrir avec
 * <label> » (règle correspondante, si une extension matche, voir
 * appsAdmin.ts), « Ouvrir avec l'application système » (xdg-open),
 * « Ouvrir dans l'éditeur » (identique au clic gauche) et, si `onPinKnowledge`
 * est fourni, « Épingler comme connaissance » (panneau « Connaissances », voir
 * AgentPage.tsx — fichiers seulement, jamais proposé sur un répertoire).
 * Clic droit sur un FICHIER OU un DOSSIER : « Renommer » / « Supprimer »
 * (Lot Historique/Édition — voir fsRename/fsDelete dans fsClient.ts) :
 *  - Renommer : édition inline dans la ligne de l'arbre (le nom devient un
 *    champ texte pré-rempli, sélectionné) — Entrée ou perte de focus valide,
 *    Échap annule. Une erreur (ex. cible déjà existante) reste affichée en
 *    ligne, sans fermer l'édition ni casser le reste de l'arbre.
 *  - Supprimer : modale de confirmation custom (definitif, pas de
 *    corbeille) — voir `DeleteConfirmModal` ci-dessous.
 * Dans les deux cas, succès ⇒ rafraîchit le dossier PARENT (racine ou
 * sous-dossier déjà en cache) et prévient le parent via `onFileRenamed`/
 * `onFileDeleted` (pour qu'AgentPage mette à jour onglets ouverts et
 * connaissances épinglées).
 * Le menu contextuel se ferme au clic ailleurs ou sur Échap. Les erreurs de
 * lancement (`open_external`) sont affichées en notice discrète dans le
 * panneau, jamais en `alert`.
 */
import { useCallback, useEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { findAppForExtension, openExternal, type AppEntry } from "./appsAdmin";
import { fsDelete, fsListDir, fsRename, type DirEntry } from "./fsClient";
import { hasModifier, useRovingFocus } from "./useRovingFocus";

interface ContextMenuState {
  path: string;
  name: string;
  isDir: boolean;
  x: number;
  y: number;
}

interface RenamingState {
  path: string;
  isDir: boolean;
  value: string;
  error: string | null;
  saving: boolean;
}

interface DeleteTarget {
  path: string;
  name: string;
  isDir: boolean;
}

/** Dossiers techniques toujours listés mais visuellement atténués. */
const DIMMED_NAMES = new Set(["node_modules", "target", "dist", ".git"]);

/* ---------- Icônes (SVG inline, teintées par familles d'extensions) ---------- */

/** Famille visuelle par extension — pilote la couleur de l'icône (voir App.css `.file-tree__icon--*`). */
const EXT_KINDS: Record<string, string> = {
  ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code", cjs: "code",
  rs: "code", py: "code", sh: "code", bash: "code", c: "code", h: "code",
  cpp: "code", go: "code", java: "code", css: "code", scss: "code",
  html: "code", vue: "code", svelte: "code", sql: "code",
  json: "data", yaml: "data", yml: "data", toml: "data", lock: "data",
  ini: "data", conf: "data", env: "data", xml: "data", csv: "data",
  md: "doc", txt: "doc", pdf: "doc", odt: "doc", doc: "doc", docx: "doc",
  png: "img", jpg: "img", jpeg: "img", gif: "img", svg: "img", webp: "img",
  ico: "img", bmp: "img", avif: "img",
  mp4: "media", mkv: "media", webm: "media", mp3: "media", wav: "media",
  flac: "media", ogg: "media",
  zip: "archive", tar: "archive", gz: "archive", xz: "archive", "7z": "archive",
  rar: "archive", deb: "archive", appimage: "archive",
};

function extKind(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "plain";
  return EXT_KINDS[name.slice(dot + 1).toLowerCase()] ?? "plain";
}

/** Icône de ligne : dossier (fermé/ouvert) ou fichier, teintée par famille. */
function TreeIcon({ isDir, open, name }: Readonly<{ isDir: boolean; open: boolean; name: string }>) {
  const kind = isDir ? (open ? "dir-open" : "dir") : extKind(name);
  return (
    <span className={`file-tree__icon file-tree__icon--${kind}`} aria-hidden="true">
      {isDir ? (
        open ? (
          <svg viewBox="0 0 16 16">
            <path d="M1.5 4.2h4l1.5 1.8h7.2" />
            <path d="M3.4 13.2 4.9 7.4h9.8l-1.6 5.8z" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16">
            <path d="M1.5 3.8h4.3l1.5 1.9h7.2v7.5H1.5z" />
          </svg>
        )
      ) : (
        <svg viewBox="0 0 16 16">
          <path d="M4 1.8h5.4L12.8 5v9.2H4z" />
          <path d="M9.2 1.8V5h3.6" />
        </svg>
      )}
    </span>
  );
}

/** Chemin absolu du dossier parent d'`path` (racine incluse). */
function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

interface TreeRowProps {
  entry: DirEntry;
  expanded: Set<string>;
  childrenByPath: Map<string, DirEntry[]>;
  loadingPaths: Set<string>;
  errorsByPath: Map<string, string>;
  onToggleDir: (entry: DirEntry) => void;
  onOpenFile: (path: string, name: string) => void;
  onContextMenuFile: (entry: DirEntry, x: number, y: number) => void;
  /** Renommage inline en cours dans l'arbre (au plus un à la fois, tous dossiers confondus) — `null` = aucun. */
  renaming: RenamingState | null;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  /** Roving tabindex (pattern Tree APG) : seul l'item de ce chemin est tabbable. */
  tabbablePath: string | null;
}

function TreeRow({
  entry,
  expanded,
  childrenByPath,
  loadingPaths,
  errorsByPath,
  onToggleDir,
  onOpenFile,
  onContextMenuFile,
  renaming,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  tabbablePath,
}: Readonly<TreeRowProps>) {
  const isExpanded = entry.isDir && expanded.has(entry.path);
  const isDimmed = DIMMED_NAMES.has(entry.name);
  const isRenaming = renaming?.path === entry.path;
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  // Passage en édition (ou d'une ligne à l'autre — un seul renommage actif à
  // la fois) : focus + sélection du nom courant, prêt à être remplacé.
  useEffect(() => {
    if (isRenaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  function handleClick() {
    if (isRenaming) return;
    if (entry.isDir) onToggleDir(entry);
    else onOpenFile(entry.path, entry.name);
  }

  function handleContextMenu(e: ReactMouseEvent) {
    e.preventDefault();
    onContextMenuFile(entry, e.clientX, e.clientY);
  }

  function handleRenameKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    // stopPropagation : évite que la touche remonte jusqu'au `onKeyDown` de
    // la ligne (qui interprète Entrée/Espace comme « ouvrir/déplier »).
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      onRenameSubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onRenameCancel();
    }
  }

  return (
    <div>
      <div
        className={`file-tree__row${isDimmed ? " file-tree__row--dim" : ""}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        role="treeitem"
        aria-expanded={entry.isDir ? isExpanded : undefined}
        tabIndex={entry.path === tabbablePath ? 0 : -1}
        data-path={entry.path}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
          }
        }}
        title={entry.path}
      >
        {entry.isDir ? (
          <span
            className={`file-tree__chevron${isExpanded ? " file-tree__chevron--open" : ""}`}
            aria-hidden="true"
          >
            ▸
          </span>
        ) : (
          <span className="file-tree__chevron file-tree__chevron--spacer" aria-hidden="true" />
        )}
        <TreeIcon isDir={entry.isDir} open={isExpanded} name={entry.name} />
        {isRenaming && renaming ? (
          <span className="file-tree__rename">
            <input
              ref={renameInputRef}
              className="file-tree__rename-input"
              value={renaming.value}
              disabled={renaming.saving}
              onChange={(e) => onRenameChange(e.currentTarget.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={onRenameSubmit}
              onClick={(e) => e.stopPropagation()}
            />
            {renaming.error && (
              <span className="file-tree__rename-error" title={renaming.error}>
                {renaming.error}
              </span>
            )}
          </span>
        ) : (
          <span className="file-tree__name">{entry.name}</span>
        )}
      </div>
      {entry.isDir && isExpanded && (
        <div className="file-tree__children" role="group">
          {loadingPaths.has(entry.path) && <div className="file-tree__hint">Chargement…</div>}
          {errorsByPath.has(entry.path) && (
            <div className="file-tree__hint file-tree__hint--error">{errorsByPath.get(entry.path)}</div>
          )}
          {(childrenByPath.get(entry.path) ?? []).map((child) => (
            <TreeRow
              key={child.path}
              entry={child}
              expanded={expanded}
              childrenByPath={childrenByPath}
              loadingPaths={loadingPaths}
              errorsByPath={errorsByPath}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
              onContextMenuFile={onContextMenuFile}
              renaming={renaming}
              onRenameChange={onRenameChange}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              tabbablePath={tabbablePath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({
  rootPath,
  onOpenFile,
  onRootEntries,
  apps,
  onPinKnowledge,
  onFileRenamed,
  onFileDeleted,
}: Readonly<{
  rootPath: string;
  onOpenFile: (path: string, name: string) => void;
  /**
   * Reçoit les entrées racine à chaque (re)chargement — permet au parent de
   * réutiliser le `fs_list_dir` déjà fait ici plutôt que d'en refaire un
   * (voir AgentPage : détection .iaction/CLAUDE.md/.claude). Doit être
   * stable (`useCallback`/identité constante) : il entre dans la dépendance
   * de l'effet qui déclenche le chargement racine.
   */
  onRootEntries?: (entries: DirEntry[]) => void;
  /** Registre d'applications externes (Lot 5, voir appsAdmin.ts) — alimente le menu contextuel. */
  apps?: AppEntry[];
  /** Épingle un fichier comme « connaissance » du projet (panneau latéral, voir AgentPage.tsx). */
  onPinKnowledge?: (path: string, name: string) => void;
  /** Renommage réussi (fichier ou dossier) — le parent adapte onglets ouverts / connaissances épinglées. */
  onFileRenamed?: (oldPath: string, newPath: string) => void;
  /** Suppression réussie (fichier ou dossier, DÉFINITIVE) — le parent ferme les onglets/retire les épinglages concernés. */
  onFileDeleted?: (path: string) => void;
}>) {
  const [rootEntries, setRootEntries] = useState<DirEntry[] | null>(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenByPath, setChildrenByPath] = useState<Map<string, DirEntry[]>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [errorsByPath, setErrorsByPath] = useState<Map<string, string>>(new Map());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const [renaming, setRenaming] = useState<RenamingState | null>(null);
  // Escape pendant l'édition inline : évite que le blur consécutif au
  // démontage du champ (React retire l'input du DOM, ce qui déclenche un
  // `blur` natif) ne relance une soumission avec la valeur abandonnée.
  const skipRenameBlurRef = useRef(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Roving tabindex (pattern Tree APG) : dernier item focusé, seul tabbable —
  // à défaut, la première entrée racine. ↑/↓/Home/End via le hook, ←/→ gérés
  // ici (ouvrir/fermer un dossier, descendre/remonter).
  const roving = useRovingFocus<HTMLDivElement>({ selector: '[role="treeitem"]', loop: false });
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const tabbablePath = focusedPath ?? rootEntries?.[0]?.path ?? null;

  const loadRoot = useCallback(
    (path: string) => {
      setRootLoading(true);
      setRootError(null);
      fsListDir(path)
        .then((entries) => {
          setRootEntries(entries);
          onRootEntries?.(entries);
        })
        .catch((err: unknown) => setRootError(err instanceof Error ? err.message : String(err)))
        .finally(() => setRootLoading(false));
    },
    [onRootEntries],
  );

  const loadChildren = useCallback((path: string) => {
    setLoadingPaths((prev) => new Set(prev).add(path));
    setErrorsByPath((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
    fsListDir(path)
      .then((entries) => setChildrenByPath((prev) => new Map(prev).set(path, entries)))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setErrorsByPath((prev) => new Map(prev).set(path, message));
      })
      .finally(() =>
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        }),
      );
  }, []);

  // Nouveau dossier projet : on repart d'un arbre vierge (le cache de
  // sous-dossiers ne correspond plus au nouveau projet).
  useEffect(() => {
    setRootEntries(null);
    setRootError(null);
    setExpanded(new Set());
    setChildrenByPath(new Map());
    setLoadingPaths(new Set());
    setErrorsByPath(new Map());
    setContextMenu(null);
    setRenaming(null);
    setDeleteTarget(null);
    setFocusedPath(null);
    if (rootPath) loadRoot(rootPath);
  }, [rootPath, loadRoot]);

  function handleToggleDir(entry: DirEntry) {
    // Repli d'un dossier dont un descendant portait le tabindex : le dossier
    // replié reprend le relais (le descendant n'est plus rendu).
    if (expanded.has(entry.path) && focusedPath?.startsWith(`${entry.path}/`)) setFocusedPath(entry.path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
        if (!childrenByPath.has(entry.path)) loadChildren(entry.path);
      }
      return next;
    });
  }

  function handleRefresh() {
    // Invalide le cache des sous-dossiers et recharge le niveau racine.
    setChildrenByPath(new Map());
    setExpanded(new Set());
    setFocusedPath(null);
    if (rootPath) loadRoot(rootPath);
  }

  /** Mémorise l'item focusé (clic, Tab, flèches) : il devient le seul tabbable. */
  function handleTreeFocus(e: ReactFocusEvent<HTMLDivElement>) {
    roving.onFocus(e);
    const row = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (row?.dataset.path) setFocusedPath(row.dataset.path);
  }

  /** Pattern Tree APG : ↑/↓/Home/End via le roving, → ouvre/descend, ← ferme/remonte. */
  function handleTreeKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    // Renommage inline en cours : aucune touche volée au champ.
    if (target instanceof HTMLInputElement) return;
    // Flèches avec modificateur : laissées au global (Alt+flèche = zone voisine).
    if (hasModifier(e)) return;
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") {
      roving.onKeyDown(e);
      return;
    }
    const row = target.closest<HTMLElement>('[role="treeitem"]');
    const path = row?.dataset.path;
    if (!row || !path) return;
    e.preventDefault();
    const expandedAttr = row.getAttribute("aria-expanded"); // null = fichier
    const asDir: DirEntry = { path, name: path.slice(path.lastIndexOf("/") + 1), isDir: true, size: 0 };
    if (e.key === "ArrowRight") {
      if (expandedAttr === "false") {
        handleToggleDir(asDir);
      } else if (expandedAttr === "true") {
        // Dossier déjà ouvert : descend au premier enfant (l'item suivant
        // dans l'ordre du document, si c'en est bien un descendant).
        const items = roving.getItems();
        const next = items[items.indexOf(row) + 1];
        if (next?.dataset.path?.startsWith(`${path}/`)) roving.setCurrent(next, true);
      }
    } else if (expandedAttr === "true") {
      handleToggleDir(asDir);
    } else {
      const parentRow = roving.getItems().find((el) => el.dataset.path === parentOf(path));
      if (parentRow) roving.setCurrent(parentRow, true);
    }
  }

  function handleContextMenuFile(entry: DirEntry, x: number, y: number) {
    setContextMenu({ path: entry.path, name: entry.name, isDir: entry.isDir, x, y });
  }

  function closeContextMenu() {
    setContextMenu(null);
  }

  // Menu ouvert : se ferme au clic ailleurs ou sur Échap.
  useEffect(() => {
    if (!contextMenu) return;
    function onPointerDown() {
      closeContextMenu();
    }
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") closeContextMenu();
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  /** Recharge le dossier parent d'un chemin renommé/supprimé — racine ou sous-dossier déjà mis en cache. */
  function refreshParentOf(path: string) {
    const parent = parentOf(path);
    if (parent === rootPath) {
      loadRoot(rootPath);
    } else {
      loadChildren(parent);
    }
  }

  /**
   * Purge tout état de cache d'arbre référant à `root` ou un de ses
   * descendants (`root/...`) : nécessaire après renommage (l'ancien chemin
   * n'existe plus, ses enfants éventuellement mis en cache sous l'ancien
   * préfixe seraient sinon des entrées mortes) ou suppression d'un dossier.
   */
  function purgeSubtree(root: string) {
    const prefix = `${root}/`;
    const matches = (p: string) => p === root || p.startsWith(prefix);
    setExpanded((prev) => new Set([...prev].filter((p) => !matches(p))));
    setChildrenByPath((prev) => {
      const next = new Map(prev);
      for (const key of next.keys()) if (matches(key)) next.delete(key);
      return next;
    });
    setErrorsByPath((prev) => {
      const next = new Map(prev);
      for (const key of next.keys()) if (matches(key)) next.delete(key);
      return next;
    });
    setLoadingPaths((prev) => new Set([...prev].filter((p) => !matches(p))));
  }

  /* ---------- Renommer (fichier ou dossier) ---------- */

  function startRename(entry: DirEntry) {
    closeContextMenu();
    setRenaming({ path: entry.path, isDir: entry.isDir, value: entry.name, error: null, saving: false });
  }

  function cancelRename() {
    skipRenameBlurRef.current = true;
    setRenaming(null);
  }

  function handleRenameChange(value: string) {
    setRenaming((prev) => (prev ? { ...prev, value, error: null } : prev));
  }

  async function submitRename() {
    if (skipRenameBlurRef.current) {
      // Provient du `blur` déclenché par le démontage du champ sur Échap : ignoré.
      skipRenameBlurRef.current = false;
      return;
    }
    if (!renaming || renaming.saving) return;
    const trimmed = renaming.value.trim();
    const originalName = renaming.path.slice(renaming.path.lastIndexOf("/") + 1);
    if (!trimmed || trimmed === originalName) {
      // Rien à faire (nom vide ou inchangé) : on referme sans appel réseau.
      setRenaming(null);
      return;
    }
    if (trimmed.includes("/")) {
      setRenaming((prev) => (prev ? { ...prev, error: "Nom simple uniquement (pas de « / »)" } : prev));
      return;
    }
    setRenaming((prev) => (prev ? { ...prev, saving: true, error: null } : prev));
    try {
      const newPath = await fsRename(renaming.path, trimmed);
      if (renaming.isDir) purgeSubtree(renaming.path);
      refreshParentOf(renaming.path);
      onFileRenamed?.(renaming.path, newPath);
      if (focusedPath === renaming.path) setFocusedPath(newPath);
      else if (focusedPath?.startsWith(`${renaming.path}/`)) setFocusedPath(null);
      setRenaming(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRenaming((prev) => (prev ? { ...prev, saving: false, error: message } : prev));
    }
  }

  /* ---------- Supprimer (fichier ou dossier, DÉFINITIF) ---------- */

  function requestDelete(entry: DirEntry) {
    closeContextMenu();
    setDeleteError(null);
    setDeleteTarget({ path: entry.path, name: entry.name, isDir: entry.isDir });
  }

  function cancelDelete() {
    if (deleting) return;
    setDeleteTarget(null);
    setDeleteError(null);
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await fsDelete(deleteTarget.path);
      if (deleteTarget.isDir) purgeSubtree(deleteTarget.path);
      if (renaming?.path === deleteTarget.path) setRenaming(null);
      if (focusedPath === deleteTarget.path || focusedPath?.startsWith(`${deleteTarget.path}/`)) setFocusedPath(null);
      refreshParentOf(deleteTarget.path);
      onFileDeleted?.(deleteTarget.path);
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  // Modale de suppression ouverte : Échap annule (sauf suppression en cours).
  useEffect(() => {
    if (!deleteTarget) return;
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape" && !deleting) {
        setDeleteTarget(null);
        setDeleteError(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteTarget, deleting]);

  /** Notice discrète (pas d'`alert`) : auto-effacée après quelques secondes. */
  function showNotice(message: string) {
    setNotice(message);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 6000);
  }

  function handleOpenExternal(path: string, command: string | null) {
    closeContextMenu();
    openExternal(path, command).catch((err: unknown) => {
      showNotice(err instanceof Error ? err.message : String(err));
    });
  }

  const matchingApp = contextMenu ? findAppForExtension(apps ?? [], contextMenu.name) : null;

  return (
    <div className="file-tree">
      {/* Le titre et le repli sont portés par la section latérale (SidebarSection) :
          l'arbre n'a plus d'en-tête propre, seul « Rafraîchir » flotte au survol. */}
      {rootPath && (
        <button
          type="button"
          className="file-tree__icon-btn file-tree__refresh"
          onClick={handleRefresh}
          title="Rafraîchir"
          aria-label="Rafraîchir l'arborescence"
        >
          ↻
        </button>
      )}
      <div
        className="file-tree__body"
        role="tree"
        ref={roving.containerRef}
        onKeyDown={handleTreeKeyDown}
        onFocus={handleTreeFocus}
      >
        {!rootPath && <p className="empty-hint file-tree__hint-block">Choisissez un projet ci-dessus.</p>}
        {rootPath && rootLoading && !rootEntries && <p className="empty-hint file-tree__hint-block">Chargement…</p>}
        {rootPath && rootError && <p className="empty-hint empty-hint--error file-tree__hint-block">{rootError}</p>}
        {rootPath &&
          rootEntries?.map((entry) => (
            <TreeRow
              key={entry.path}
              entry={entry}
              expanded={expanded}
              childrenByPath={childrenByPath}
              loadingPaths={loadingPaths}
              errorsByPath={errorsByPath}
              onToggleDir={handleToggleDir}
              onOpenFile={onOpenFile}
              onContextMenuFile={handleContextMenuFile}
              renaming={renaming}
              onRenameChange={handleRenameChange}
              onRenameSubmit={() => void submitRename()}
              onRenameCancel={cancelRename}
              tabbablePath={tabbablePath}
            />
          ))}
      </div>
      {notice && (
        <div className="file-tree__notice">
          {notice}
          <button
            type="button"
            className="file-tree__notice-dismiss"
            onClick={() => setNotice(null)}
            aria-label="Masquer la notification"
          >
            ×
          </button>
        </div>
      )}
      {contextMenu && (
        <div
          className="file-tree__context-menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          // Le `mousedown` global ferme le menu (voir l'effet ci-dessus) : on stoppe sa
          // propagation ici pour qu'un clic SUR le menu ne se ferme pas avant que `onClick`
          // ait pu s'exécuter sur l'item choisi.
          onMouseDown={(e) => e.stopPropagation()}
          role="menu"
          tabIndex={-1}
        >
          {!contextMenu.isDir && matchingApp && (
            <button
              type="button"
              className="file-tree__context-menu-item"
              role="menuitem"
              onClick={() => handleOpenExternal(contextMenu.path, matchingApp.command)}
            >
              Ouvrir avec {matchingApp.label}
            </button>
          )}
          {!contextMenu.isDir && (
            <button
              type="button"
              className="file-tree__context-menu-item"
              role="menuitem"
              onClick={() => handleOpenExternal(contextMenu.path, null)}
            >
              Ouvrir avec l'application système
            </button>
          )}
          {!contextMenu.isDir && (
            <button
              type="button"
              className="file-tree__context-menu-item"
              role="menuitem"
              onClick={() => {
                onOpenFile(contextMenu.path, contextMenu.name);
                closeContextMenu();
              }}
            >
              Ouvrir dans l'éditeur
            </button>
          )}
          {!contextMenu.isDir && onPinKnowledge && (
            <button
              type="button"
              className="file-tree__context-menu-item"
              role="menuitem"
              onClick={() => {
                onPinKnowledge(contextMenu.path, contextMenu.name);
                closeContextMenu();
              }}
            >
              Épingler comme connaissance
            </button>
          )}
          <button
            type="button"
            className="file-tree__context-menu-item"
            role="menuitem"
            onClick={() =>
              startRename({ path: contextMenu.path, name: contextMenu.name, isDir: contextMenu.isDir, size: 0 })
            }
          >
            Renommer
          </button>
          <button
            type="button"
            className="file-tree__context-menu-item file-tree__context-menu-item--danger"
            role="menuitem"
            onClick={() =>
              requestDelete({ path: contextMenu.path, name: contextMenu.name, isDir: contextMenu.isDir, size: 0 })
            }
          >
            Supprimer
          </button>
        </div>
      )}
      {deleteTarget && (
        <div
          className="permission-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) cancelDelete();
          }}
        >
          <div className="permission-modal delete-confirm-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="permission-modal__head">
              <h3>Supprimer {deleteTarget.name} ?</h3>
            </div>
            <div className="permission-modal__body">
              <p className="delete-confirm__path" title={deleteTarget.path}>
                {deleteTarget.path}
              </p>
              <p className="delete-confirm__warning">
                ⚠ Suppression définitive{deleteTarget.isDir ? " et de tout son contenu" : ""} — pas de corbeille,
                action irréversible.
              </p>
              {deleteError && <p className="result-line result-line--error">{deleteError}</p>}
            </div>
            <div className="permission-modal__actions">
              <button type="button" className="btn btn--ghost" onClick={cancelDelete} disabled={deleting}>
                Annuler
              </button>
              <button type="button" className="btn btn--deny" onClick={() => void confirmDelete()} disabled={deleting}>
                {deleting ? "Suppression…" : "Supprimer"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
