/*
 * Panneau « Ping » de la page Système : la requête la plus petite du
 * protocole, et le temps qu'elle met à revenir.
 *
 * Sorti de `SystemPage.tsx` le 2026-08-26 : la page avait atteint son budget
 * de taille au caractère près, et le panneau « Mise à jour » (T-056) n'y
 * tenait plus. Ce panneau-ci était le candidat évident — il ne partage rien
 * avec le reste de la page, ni état ni style.
 */
import { useState } from "react";

import { request } from "./sidecar";

type PingState = "idle" | "pending" | "error";

export function PingPanel() {
  const [state, setState] = useState<PingState>("idle");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  async function handlePing() {
    setState("pending");
    setErrorMessage("");
    const startedAt = Date.now();
    try {
      const { done } = request("ping", {});
      await done;
      setLatencyMs(Date.now() - startedAt);
      setState("idle");
    } catch (err) {
      setState("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  let resultClass = "result-line";
  let resultText = "Aucun ping envoyé pour l'instant.";
  if (state === "error") {
    resultClass += " result-line--error";
    resultText = `Erreur : ${errorMessage}`;
  } else if (latencyMs !== null) {
    resultClass += " result-line--ok";
    resultText = `Pong reçu en ${latencyMs} ms`;
  }

  return (
    <section className="panel">
      <h2 className="panel__title">Ping</h2>
      <p className="empty-hint">
        Envoie une requête <code>ping</code> minimale et mesure le temps jusqu'au <code>done</code>.
      </p>
      <div className="actions">
        <button className="btn" onClick={handlePing} disabled={state === "pending"}>
          {state === "pending" ? "Envoi…" : "Envoyer un ping"}
        </button>
      </div>
      <div className={resultClass}>{resultText}</div>
    </section>
  );
}
