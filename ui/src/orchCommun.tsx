/*
 * Socle commun de la page Orchestration : état de chargement, libellés,
 * prévisualisations YAML, ordre du DAG, encart d'erreur. Fonctions PURES en
 * tête — ce sont elles que orchCommun.test.ts vérifie.
 * Extrait d'OrchestrationPage le 2026-08-08 (étape 7) — déplacement pur.
 */

/*
 * Page « Orchestration » (phase O1, voir docs/etude-orchestration.md § 5) :
 * sous-navigation en pilules (même patron que ProvidersPage) — Agents /
 * Orchestrations / Exécutions / Tâches (T1, docs/etude-taches.md § 3.3) —
 * au-dessus d'un sélecteur de contexte projet qui détermine le `cwd` passé
 * aux méthodes `agents.*`/`orch.*` (`null` = « Global uniquement »). Ce
 * sélecteur gagne un optgroup « Tâches » (T1) : choisir une tâche pointe le
 * `cwd` sur son dossier — du point de vue des scopes `agents.*`/`orch.*`,
 * une tâche sélectionnée s'affiche comme un contexte « Projet » ordinaire
 * (mêmes libellés, aucune notion de « tâche » côté agents/orchestrations).
 *
 * Les panneaux Agents/Orchestrations restent montés en permanence (masqués
 * via CSS, même pattern que `config-panel` dans ProvidersPage) : la liste
 * des agents est nécessaire aux DEUX (le sélecteur d'agent d'une étape
 * d'orchestration vient de la même liste), donc chargée indépendamment de
 * l'onglet actif. Un changement de contexte projet REMONTE les deux
 * sections (`key={cwd}`) : ça réinitialise proprement tout éditeur ouvert
 * plutôt que de le laisser pointer vers un `cwd` périmé. Le panneau Tâches
 * n'a pas besoin de ce `key={cwd}` : les méthodes `taches.*` n'ont pas de
 * notion de `cwd`/portée (répertoire racine unique côté sidecar).
 */

import {
  type AgentInfo,
  type AgentScope,
  type AgentWriteInput,
  type OrchestrationStep,
  type OrchestrationWriteInput,
} from "./orchestrationClient";
import { type ProviderConfig } from "./providerAdmin";
import {
  type TacheWriteInput,
} from "./tachesClient";

export type LoadState = "loading" | "ready" | "error";

/* ---------- Utilitaires partagés ---------- */

/** Un sidecar pas encore à jour rejette avec un message de type « méthode inconnue ». */
export function looksLikeUnknownMethod(message: string): boolean {
  return /m[ée]thode inconnue|unknown method|non impl[ée]ment[ée]e|not implemented/i.test(message);
}


export function agentScopeLabel(scope: AgentScope): string {
  if (scope === "global") return "Global";
  if (scope === "claude-code") return "Claude Code";
  return "Projet";
}

export function engineChipLabel(agent: Pick<AgentInfo, "engine" | "provider" | "model">, providers: ProviderConfig[]): string {
  if (agent.engine === "claude") return `Claude · ${agent.model || "défaut"}`;
  // R2 — moteur/modèle choisis par le routeur à l'exécution.
  if (agent.engine === "auto") return "Auto (routeur)";
  const label = providers.find((p) => p.id === agent.provider)?.label ?? agent.provider ?? "Neutre";
  return `${label} · ${agent.model || "—"}`;
}

export const TOOL_OPTIONS: { value: string; label: string }[] = [
  { value: "read_file", label: "Lire un fichier" },
  { value: "list_dir", label: "Lister un dossier" },
  { value: "search", label: "Rechercher" },
  { value: "write_file", label: "Écrire un fichier" },
  { value: "edit_file", label: "Éditer un fichier" },
  { value: "bash", label: "Bash" },
];

export { PERMISSION_MODE_OPTIONS } from "./permissions";

/** Sérialisation minimale (pas un vrai parseur — le sidecar est seul juge du format, voir orchestrationClient.ts). */
export function yamlScalar(s: string): string {
  if (s === "") return '""';
  if (/^[A-Za-z0-9_\-./]+$/.test(s) && !/^(true|false|null|~)$/i.test(s)) return s;
  return JSON.stringify(s);
}

export function yamlBlockScalar(s: string, contentIndent: string): string {
  if (!s) return '""';
  return `|\n${s.split("\n").map((l) => `${contentIndent}${l}`).join("\n")}`;
}

export function agentYamlPreview(input: AgentWriteInput): string {
  const lines: string[] = [];
  lines.push(`name: ${input.name || "(sans nom)"}`);
  lines.push(`description: ${yamlScalar(input.description)}`);
  lines.push(`engine: ${input.engine}`);
  lines.push(`provider: ${input.provider ? yamlScalar(input.provider) : "null"}`);
  lines.push(`model: ${input.model ? yamlScalar(input.model) : "null"}`);
  lines.push(`permissionMode: ${input.permissionMode}`);
  lines.push(`instructions: ${yamlBlockScalar(input.instructions, "  ")}`);
  if (input.tools === null) {
    lines.push(`tools: null`);
  } else {
    lines.push(`tools:`);
    for (const t of input.tools) lines.push(`  - ${t}`);
  }
  lines.push(`mcp: ${input.mcp}`);
  if (input.knowledge.length === 0) {
    lines.push(`knowledge: []`);
  } else {
    lines.push(`knowledge:`);
    for (const k of input.knowledge) lines.push(`  - ${yamlScalar(k)}`);
  }
  lines.push(`maxTurns: ${input.maxTurns ?? "null"}`);
  return `${lines.join("\n")}\n`;
}

export function orchestrationYamlPreview(input: OrchestrationWriteInput): string {
  const lines: string[] = [];
  lines.push(`name: ${input.name || "(sans nom)"}`);
  lines.push(`description: ${yamlScalar(input.description)}`);
  if (input.inputs.length === 0) {
    lines.push(`inputs: []`);
  } else {
    lines.push(`inputs:`);
    for (const inp of input.inputs) {
      lines.push(`  - name: ${inp.name}`);
      lines.push(`    label: ${yamlScalar(inp.label)}`);
      // `default` : absent = requis ; chaîne (même vide) = valeur au lancement.
      if (inp.default !== null) lines.push(`    default: ${yamlScalar(inp.default)}`);
    }
  }
  if (input.steps.length === 0) {
    lines.push(`steps: []`);
  } else {
    lines.push(`steps:`);
    for (const step of input.steps) {
      lines.push(`  - id: ${step.id}`);
      lines.push(`    agent: ${step.agent}`);
      lines.push(`    task: ${yamlBlockScalar(step.task, "      ")}`);
      if (step.needs.length > 0) lines.push(`    needs: [${step.needs.join(", ")}]`);
    }
  }
  lines.push(`limits:`);
  lines.push(`  maxParallel: ${input.limits.maxParallel}`);
  lines.push(`  maxDurationMin: ${input.limits.maxDurationMin}`);
  return `${lines.join("\n")}\n`;
}

export function tacheYamlPreview(input: TacheWriteInput): string {
  const lines: string[] = [];
  lines.push(`name: ${input.name || "(sans nom)"}`);
  lines.push(`description: ${yamlScalar(input.description)}`);
  lines.push(`orchestration: ${input.orchestration || "(orchestration manquante)"}`);
  lines.push(`schedule: ${input.schedule ? yamlScalar(input.schedule) : "null"}`);
  const inputEntries = Object.entries(input.inputs);
  if (inputEntries.length === 0) {
    lines.push(`inputs: {}`);
  } else {
    lines.push(`inputs:`);
    for (const [k, v] of inputEntries) lines.push(`  ${k}: ${yamlScalar(v)}`);
  }
  lines.push(`report: ${input.report ? yamlScalar(input.report) : "null"}`);
  lines.push(`enabled: ${input.enabled}`);
  lines.push(`cwd: ${input.cwd ? yamlScalar(input.cwd) : "null"}`);
  // Reflété même sans contrôle d'interface (l'édition du lieu est la tranche
  // D3) : l'aperçu doit montrer EXACTEMENT ce qui sera écrit, sans quoi une
  // tâche `serveur` semblerait repasser en `local` — ou pire, le ferait.
  lines.push(`lieu: ${input.lieu}`);
  return `${lines.join("\n")}\n`;
}

/** Date locale `YYYY-MM-DD` (résolution du gabarit `{{today}}`, voir docs/protocol.md § T1). */
export function localDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Résout `{{today}}` dans les valeurs d'un objet d'inputs (clefs inchangées) — voir « Lancer maintenant ». */
export function resolveTodayTemplates(inputs: Record<string, string>): Record<string, string> {
  const today = localDateISO(new Date());
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputs)) out[k] = v.split("{{today}}").join(today);
  return out;
}

export function formatReportDate(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Aperçu du DAG : profondeur = 1 + profondeur max de ses dépendances (0 si sans `needs`). */
export function computeDagOrder(steps: OrchestrationStep[]): { step: OrchestrationStep; index: number; depth: number }[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const depthCache = new Map<string, number>();

  function depthOf(id: string, seen: Set<string>): number {
    if (depthCache.has(id)) return depthCache.get(id) as number;
    if (seen.has(id)) return 0; // cycle : pas de garde-fou plus fin ici, juste éviter la boucle infinie
    const step = byId.get(id);
    if (!step || step.needs.length === 0) {
      depthCache.set(id, 0);
      return 0;
    }
    const nextSeen = new Set(seen).add(id);
    const depths = step.needs.filter((n) => byId.has(n)).map((n) => depthOf(n, nextSeen));
    const depth = depths.length === 0 ? 0 : 1 + Math.max(...depths);
    depthCache.set(id, depth);
    return depth;
  }

  return steps
    .map((step, index) => ({ step, index, depth: depthOf(step.id, new Set()) }))
    .sort((a, b) => a.depth - b.depth);
}

export function ErrorOrStaleHint({ stale, message }: Readonly<{ stale: boolean; message: string }>) {
  if (stale) {
    return (
      <div className="result-line result-line--warn">
        ⚠ Moteur trop ancien : redémarre l'application (méthode non reconnue par le sidecar).
      </div>
    );
  }
  return <div className="result-line result-line--error">Erreur de chargement : {message}</div>;
}

/* ================= Agents ================= */

