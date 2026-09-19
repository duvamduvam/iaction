/*
 * Bandeaux de la coquille — ce que l'application dit quand elle ne peut plus
 * rien faire d'utile.
 *
 * Les deux qui vivent ici répondent à la même famille de panne : un étage sous
 * l'interface a lâché, donc AUCUNE page ne marchera, donc l'information
 * n'appartient à aucune d'elles. Elles sont au niveau de la coquille pour cette
 * raison, pas par commodité.
 *
 * Règle commune, et c'est tout leur intérêt : ils ne réparent rien tout seuls.
 * Un rechargement automatique effacerait ce que l'utilisateur était en train de
 * taper et, surtout, rendrait la panne invisible une deuxième fois.
 */

import { useEffect, useState } from "react";

import { armerGardeBoot } from "./gardeBoot";
import { fetchStatus, restartSidecar, subscribeStatus } from "./sidecar";

/**
 * Bandeau global proposant de relancer le sidecar quand il est mort.
 *
 * L'état `dead` (cinq échecs rapprochés) n'offrait aucune issue dans
 * l'application : il fallait la quitter entièrement — donc perdre fenêtre,
 * onglets et session en cours — pour une panne le plus souvent passagère
 * (sidecar recompilé sous les pieds de l'application, par exemple).
 */
export function SidecarMortBanner() {
  const [dead, setDead] = useState(false);
  const [relance, setRelance] = useState(false);
  const [erreur, setErreur] = useState("");

  useEffect(() => {
    fetchStatus()
      .then((s) => setDead(s.state === "dead"))
      .catch(() => {});
    return subscribeStatus((s) => {
      setDead(s.state === "dead");
      if (s.state !== "dead") {
        setRelance(false);
        setErreur("");
      }
    });
  }, []);

  if (!dead) return null;
  return (
    <div className="sidecar-dead-banner">
      <span>
        Le moteur de l'application (sidecar) s'est arrêté après plusieurs échecs. Les conversations
        enregistrées sont intactes.
      </span>
      <button
        type="button"
        className="btn"
        disabled={relance}
        onClick={() => {
          setRelance(true);
          setErreur("");
          restartSidecar().catch((err) => {
            setRelance(false);
            setErreur(err instanceof Error ? err.message : String(err));
          });
        }}
      >
        {relance ? "Relance…" : "Relancer le moteur"}
      </button>
      {erreur && <span className="sidecar-dead-banner__error">{erreur}</span>}
    </div>
  );
}

/**
 * Bandeau « la coquille ne répond pas » (T-009).
 *
 * La sonde est `fetchStatus` — la commande Tauri la plus élémentaire, servie
 * par la coquille elle-même et non par le sidecar : elle répond même quand le
 * moteur est mort. Si ELLE ne répond pas, ce n'est donc pas le moteur qui
 * manque, c'est la greffe IPC qui ne s'est jamais établie — le cas constaté le
 * 2026-08-08, page à moitié chargée pendant la ré-optimisation de vite.
 *
 * Le bandeau ne s'efface pas de lui-même si une réponse arrive après coup : la
 * greffe rétablie ne rend pas les treize minutes perdues, et l'utilisateur doit
 * pouvoir lire ce qui s'est passé. Il disparaît au rechargement, qui est
 * justement le remède.
 */
export function BandeauCoquilleMuette() {
  const [muette, setMuette] = useState(false);

  useEffect(() => {
    const garde = armerGardeBoot({ auSilence: () => setMuette(true) });
    fetchStatus()
      // Une réponse, même en erreur, prouve que le pont fonctionne : c'est le
      // SILENCE qu'on traque, pas l'échec.
      .then(() => garde.signalerVivant())
      .catch(() => garde.signalerVivant());
    return () => garde.arreter();
  }, []);

  if (!muette) return null;
  return (
    <div className="sidecar-dead-banner">
      <span>
        L'interface n'a reçu aucune réponse de l'application depuis son ouverture. La page a
        probablement été chargée trop tôt — un rechargement suffit, rien n'est perdu.
      </span>
      <button type="button" className="btn" onClick={() => window.location.reload()}>
        Recharger la page
      </button>
    </div>
  );
}
