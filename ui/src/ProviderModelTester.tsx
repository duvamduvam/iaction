/*
 * R8-A §5 — « Tester » modèle par modèle.
 *
 * ── Pourquoi ce bouton existe ──────────────────────────────────────────
 * T-025 : un fournisseur peut encoder sa panne DANS le corps d'une réponse
 * HTTP 200 — phrase d'erreur anglaise, `finish_reason: "stop"`, compteurs à
 * zéro. Vu du protocole, rien ne la distingue d'une réponse légitime, et
 * l'application la présente donc comme une réussite.
 *
 * ── Pourquoi on ne l'automatise pas ────────────────────────────────────
 * Deux fausses bonnes idées, écartées par la spec :
 *
 * - **valider les 132 modèles au chargement** : coût absurde, et une mesure du
 *   2026-08-11 montre qu'elle ne prouverait rien — le modèle fautif répond
 *   correctement 9 fois sur 10. Un appel de validation le déclarerait vivant ;
 * - **reconnaître la phrase d'erreur** : filtrer un texte anglais dans une
 *   réponse d'assistant condamnerait des réponses légitimes. On échangerait un
 *   faux négatif contre un faux positif.
 *
 * Reste ce qu'on peut honnêtement faire : donner à l'utilisateur le moyen
 * d'essayer, un modèle à la fois, et lui MONTRER ce qui revient — c'est lui
 * qui juge. T-025 reste ouvert, et c'est voulu.
 */
import { useState } from "react";

import { chatSend, modelsList } from "./sidecar";

type Etat = "idle" | "loading" | "ready" | "error";

interface Verdict {
  ok: boolean;
  /** Ce que le fournisseur a réellement répondu, ou le message d'erreur. */
  message: string;
}

/** Longueur d'extrait affichée : assez pour reconnaître une phrase d'erreur. */
const EXTRAIT = 120;

export function ProviderModelTester({
  providerId,
}: Readonly<{
  providerId: string;
}>) {
  const [etat, setEtat] = useState<Etat>("idle");
  const [erreur, setErreur] = useState("");
  const [modeles, setModeles] = useState<string[]>([]);
  const [verdicts, setVerdicts] = useState<Record<string, Verdict | "pending">>({});
  const [filtre, setFiltre] = useState("");

  async function charger() {
    setEtat("loading");
    setErreur("");
    try {
      const liste = await modelsList(providerId);
      setModeles(liste.map((m) => m.id));
      setEtat("ready");
    } catch (err) {
      setEtat("error");
      setErreur(err instanceof Error ? err.message : String(err));
    }
  }

  async function tester(model: string) {
    setVerdicts((prev) => ({ ...prev, [model]: "pending" }));
    let texte = "";
    try {
      const { done } = chatSend(
        providerId,
        model,
        [{ role: "user", content: "ping" }],
        // Un seul jeton demandé : on vérifie qu'un tour ABOUTIT, on ne fait
        // pas travailler le modèle — et on ne paie pas 132 réponses.
        { maxTokens: 1 },
        (delta) => {
          texte += delta;
        },
      );
      await done;
      const propre = texte.trim();
      setVerdicts((prev) => ({
        ...prev,
        [model]: {
          ok: propre.length > 0,
          message: propre.length > 0 ? propre.slice(0, EXTRAIT) : "réponse vide",
        },
      }));
    } catch (err) {
      setVerdicts((prev) => ({
        ...prev,
        [model]: { ok: false, message: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  const q = filtre.trim().toLowerCase();
  const visibles = q ? modeles.filter((m) => m.toLowerCase().includes(q)) : modeles;

  return (
    <div className="provider-card__models">
      {etat !== "ready" && (
        <button className="btn btn--ghost" onClick={() => void charger()} disabled={etat === "loading"}>
          {etat === "loading" ? "Chargement…" : "Voir et tester les modèles"}
        </button>
      )}
      {etat === "error" && <div className="result-line result-line--error">Erreur : {erreur}</div>}
      {etat === "ready" && (
        <>
          <p className="empty-hint">
            {modeles.length} modèle(s). Un test envoie un tour d'un jeton et affiche ce que le
            fournisseur répond vraiment — une plateforme peut renvoyer sa panne dans une réponse
            d'apparence normale (T-025).
          </p>
          <input
            value={filtre}
            onChange={(e) => setFiltre(e.currentTarget.value)}
            placeholder="filtrer les modèles…"
            aria-label="Filtrer les modèles"
          />
          {visibles.map((model) => {
            const verdict = verdicts[model];
            return (
              <div key={model} className="provider-card__model-row">
                <span className="model-row__id">{model}</span>
                <button
                  className="btn btn--ghost"
                  onClick={() => void tester(model)}
                  disabled={verdict === "pending"}
                >
                  {verdict === "pending" ? "…" : "Tester"}
                </button>
                {verdict && verdict !== "pending" && (
                  <span
                    className={`result-line ${verdict.ok ? "result-line--ok" : "result-line--error"}`}
                    title={verdict.message}
                  >
                    {verdict.ok ? "✓" : "✗"} {verdict.message}
                  </span>
                )}
              </div>
            );
          })}
          {visibles.length === 0 && <p className="empty-hint">Aucun modèle ne correspond.</p>}
        </>
      )}
    </div>
  );
}
