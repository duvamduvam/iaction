// Point d'entrée de l'UI. L'import de `./journal` a un EFFET DE BORD voulu :
// il installe la capture globale des erreurs de la webview (`window.onerror`,
// `unhandledrejection`) le plus tôt possible — il remplace la sonde temporaire
// `devErrorProbe.ts`, qui postait sur un collecteur local inexistant.
import "./journal";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import { jalonPremierRendu, jalonScript } from "./demarrage";
import "./theme.css";

// Avant tout rendu : ce jalon clôt le segment « webview + chargement du JS »,
// invisible depuis le Rust (voir demarrage.ts).
jalonScript();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// Armé APRÈS `render` : le rendu de React est asynchrone, seul un tour
// d'animation dit quand l'image est effectivement peinte.
jalonPremierRendu();
