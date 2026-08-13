/*
 * R9 — liste des sources web citées sous une réponse.
 *
 * Sorti de ChatPage pour la raison habituelle du projet : le composant faisait
 * grossir un fichier déjà sous dérogation, et le cliquet de taille l'a refusé.
 * Il n'a besoin de rien d'autre que de ses props — donc il n'a rien à faire
 * dans un fichier de 2 700 lignes.
 */
import type { SourceWeb } from "./rechercheWeb";

/**
 * Rendu vide (et non un encadré vide) quand il n'y a pas de source : une
 * réponse sans recherche ne doit pas afficher une zone « sources » muette.
 */
export function SourcesWeb({ sources }: { sources?: SourceWeb[] }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="chat-bubble__sources">
      {sources.map((s) => (
        <a key={s.url} href={s.url} target="_blank" rel="noreferrer noopener" title={s.url}>
          [{s.n}] {s.titre}
        </a>
      ))}
    </div>
  );
}
