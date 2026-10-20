/*
 * Filet de sécurité du rendu React — tranche L2 du journal applicatif
 * (docs/etude-logs.md § 2.3).
 *
 * POURQUOI : une exception levée pendant un rendu démonte tout l'arbre React
 * et laisse un écran BLANC, sans le moindre indice — la panne exacte que la
 * sonde temporaire `devErrorProbe.ts` essayait de diagnostiquer. Ici l'erreur
 * est journalisée en `fatal` (l'interface est hors service) avec sa pile et le
 * `componentStack` qui désigne le composant fautif, puis un repli sobre est
 * affiché à la place de l'écran blanc.
 *
 * T-116 — EXCEPTION au `fatal` systématique : sous Vite en développement
 * (`import.meta.env.DEV`), un graphe HMR périmé après une édition démonte
 * l'arbre avec un message d'une famille reconnaissable (`estArtefactHmr`,
 * module à part car FONCTION PURE) — la version empaquetée ne peut pas
 * produire ces messages. Dans ce cas précis, le niveau descend en `warn` et
 * l'entrée porte `artefactHmr: true` pour rester filtrable, mais la ligne
 * n'est jamais tue et garde sa pile. Un crash de rendu qui n'est pas de cette
 * famille, ou qui survient hors développement, reste `fatal`.
 *
 * Un ErrorBoundary NE PEUT être qu'un composant de classe : React n'expose pas
 * d'équivalent en hooks (toujours vrai en React 19). Il est monté dans
 * `main.tsx`, AUTOUR de `<App />`, donc au-dessus de tout ce que l'application
 * rend. Le style réutilise les classes existantes du thème néon (`panel`,
 * `result-line--error`, `empty-hint`, `btn`) : aucune règle CSS ajoutée.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { estArtefactHmr } from "./artefactHmr";
import { logUi, type LogLevel } from "./journal";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  /** Message de l'erreur qui a démonté l'arbre, `null` tant que tout va bien. */
  erreur: string | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { erreur: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message = error instanceof Error ? error.message : String(error);
    return { erreur: message || "erreur inconnue" };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const erreur = error instanceof Error ? error : null;
    const message = erreur?.message || String(error) || "erreur inconnue";
    // `componentStack` (pile des composants React) est joint à la pile JS :
    // c'est lui qui désigne le composant fautif, la pile JS seule pointant
    // souvent dans le runtime React. Lecture défensive : le champ est
    // optionnel/nullable selon les versions de React.
    const componentStack =
      typeof info?.componentStack === "string" && info.componentStack ? info.componentStack : "";
    const pile = erreur?.stack ?? "";
    const stack = componentStack
      ? `${pile}\n--- componentStack ---${componentStack}`
      : pile || null;
    // `fatal` par défaut : l'arbre React est démonté, l'application n'est
    // plus utilisable tant qu'elle n'a pas été rechargée. EXCEPTION T-116:
    // sous Vite en développement, un message de la famille HMR descend en
    // `warn` et porte `artefactHmr: true` — voir l'en-tête du fichier.
    const artefactHmr = import.meta.env.DEV && estArtefactHmr(message);
    const niveau: LogLevel = artefactHmr ? "warn" : "fatal";
    logUi(niveau, "ui", `rendu React interrompu : ${message}`, {
      stack,
      ...(artefactHmr ? { fields: { artefactHmr: true } } : {}),
    });
  }

  private recharger = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.erreur === null) return this.props.children;
    return (
      <div style={{ padding: "var(--space-5)", maxWidth: "48rem", margin: "0 auto" }}>
        <section className="panel">
          <h2 className="panel__title">L'interface s'est interrompue</h2>
          <p className="result-line result-line--error">{this.state.erreur}</p>
          <p className="empty-hint">
            L'erreur a été enregistrée dans le journal applicatif (page Système). Recharger la
            fenêtre remet l'interface en marche ; les conversations déjà enregistrées sont
            intactes.
          </p>
          <div className="actions">
            <button className="btn" onClick={this.recharger}>
              Recharger
            </button>
          </div>
        </section>
      </div>
    );
  }
}
