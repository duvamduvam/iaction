// Point d'entrée de l'UI. L'import de `./journal` a un EFFET DE BORD voulu :
// il installe la capture globale des erreurs de la webview (`window.onerror`,
// `unhandledrejection`) le plus tôt possible — il remplace la sonde temporaire
// `devErrorProbe.ts`, qui postait sur un collecteur local inexistant.
import "./journal";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import "./theme.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
