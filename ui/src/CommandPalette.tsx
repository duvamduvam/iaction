/*
 * Palette de bascule rapide de projet (Ctrl+Maj+P / Cmd+Maj+P, partout dans
 * l'app — voir docs/plan.md axe 4 : « changement rapide de projet »).
 * Anciennement sur Ctrl+K : déplacée pour libérer ce raccourci, réattribué
 * au vidage de la conversation en cours (voir App.tsx).
 *
 * Architecture — App possède-t-il le « projet sélectionné » ? NON. Le
 * lifting complet de `selectedProjectId` dans App aurait obligé à faire
 * remonter aussi `streaming`/`projectStatesRef`/tout le cycle de vie de
 * l'état par projet d'AgentPage (voir son en-tête de fichier), ce qui aurait
 * cassé l'isolation soigneusement documentée là-bas pour un gain nul. Choix
 * retenu : AgentPage garde la pleine propriété de son état, et expose une
 * API impérative minimale via `ref` (`useImperativeHandle`, voir
 * `AgentPageHandle` dans AgentPage.tsx) — un « bus » à un seul message
 * (« sélectionne ce projet, dis-moi si tu as pu »). App.tsx détient ce ref
 * et le branche sur `onSelectProject` ci-dessous ; ce composant ne connaît
 * ni AgentPage ni le ref, seulement ce callback synchrone.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ProjectConfig } from "./projectAdmin";

interface CommandPaletteProps {
  projects: ProjectConfig[];
  /** Tente la bascule ; renvoie `false` si refusée (run en cours). */
  onSelectProject: (id: string) => boolean;
}

/**
 * Sous-séquence insensible à la casse : `query` doit apparaître, dans
 * l'ordre, dans `text` (caractères non forcément contigus). Renvoie
 * l'étendue (indice de fin − indice de début) du match le plus compact
 * trouvé par un simple parcours glouton, ou `null` si aucun match — sert de
 * score de pertinence (plus petit = meilleur).
 */
function fuzzyScore(text: string, query: string): number | null {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let ti = 0;
  let qi = 0;
  let start = -1;
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) {
      if (start === -1) start = ti;
      qi += 1;
    }
    ti += 1;
  }
  if (qi < q.length) return null;
  return ti - start;
}

function filterProjects(projects: ProjectConfig[], query: string): ProjectConfig[] {
  const trimmed = query.trim();
  if (!trimmed) return projects;
  return projects
    .map((project) => ({ project, score: fuzzyScore(`${project.name} ${project.path}`, trimmed) }))
    .filter((entry): entry is { project: ProjectConfig; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.project);
}

export function CommandPalette({ projects, onSelectProject }: Readonly<CommandPaletteProps>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Raccourci global : Ctrl+Maj+P / Cmd+Maj+P ouvre/ferme, partout dans l'app.
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Ouverture : repart d'un champ vierge et focus la recherche.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setNotice(null);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const results = filterProjects(projects, query);

  function choose(id: string) {
    const ok = onSelectProject(id);
    if (ok) {
      setOpen(false);
    } else {
      setNotice("Un run est en cours dans ce projet — impossible de basculer pour l'instant.");
    }
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    setActiveIndex(0);
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = results[activeIndex];
      if (target) choose(target.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  if (!open) return null;

  return (
    <div className="cmdk-overlay" onClick={() => setOpen(false)}>
      <div
        className="cmdk-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Basculer de projet"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          type="text"
          value={query}
          onChange={(e) => handleQueryChange(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder="Basculer vers un projet…"
          aria-label="Rechercher un projet"
        />
        <div className="cmdk-list" role="listbox" aria-label="Projets">
          {results.length === 0 && <div className="cmdk-empty">Aucun projet trouvé.</div>}
          {results.map((project, i) => (
            <div
              key={project.id}
              className={`cmdk-item${i === activeIndex ? " cmdk-item--active" : ""}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => choose(project.id)}
            >
              <span className="cmdk-item__name">{project.name}</span>
              <span className="cmdk-item__path">{project.path}</span>
            </div>
          ))}
        </div>
        {notice && <div className="cmdk-notice">{notice}</div>}
        <div className="cmdk-hint">↑↓ naviguer · Entrée choisir · Échap fermer</div>
      </div>
    </div>
  );
}
