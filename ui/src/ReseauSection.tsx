/*
 * Encart « Réseau » de la page Configuration (T-045).
 *
 * Composant à part, et pas quarante lignes de plus dans ProvidersPage : cette
 * page est déjà un fichier-dieu sous cliquet, et un encart qui ne partage rien
 * avec les autres n'a aucune raison d'y vivre. Toute la décision (lecture,
 * validation, forme écrite) est dans reseauAdmin.ts, testée sans fenêtre.
 */
import { useEffect, useState } from "react";

import { avertissementProxy, readReseau, RESEAU_VIDE, writeReseau, type ReglagesReseau } from "./reseauAdmin";
import { restartSidecar } from "./sidecar";

export function ReseauSection({ active }: Readonly<{ active: boolean }>) {
  const [reglages, setReglages] = useState<ReglagesReseau>(RESEAU_VIDE);
  const [avis, setAvis] = useState("");
  const [charge, setCharge] = useState(false);

  useEffect(() => {
    if (!active || charge) return;
    setCharge(true);
    readReseau()
      .then(setReglages)
      .catch((err: unknown) => setAvis(err instanceof Error ? err.message : String(err)));
  }, [active, charge]);

  const modifier = (patch: Partial<ReglagesReseau>) => setReglages((r) => ({ ...r, ...patch }));

  async function enregistrer(relancer: boolean) {
    try {
      await writeReseau(reglages);
      if (relancer) {
        await restartSidecar();
        setAvis("Réglages enregistrés, moteur relancé — ils s'appliquent à partir de maintenant.");
      } else {
        setAvis("Réglages enregistrés. Ils ne s'appliqueront qu'au prochain démarrage du moteur.");
      }
    } catch (err: unknown) {
      setAvis(err instanceof Error ? err.message : String(err));
    }
  }

  const alerteProxy = avertissementProxy(reglages.proxy);

  return (
    <section className="panel">
      <h2 className="panel__title">Réseau</h2>
      <p className="panel__hint">
        À remplir seulement derrière un proxy d'entreprise. Laissé vide, rien ne change : l'application
        utilise les variables d'environnement du poste, comme avant.
      </p>

      <div className="field">
        <label htmlFor="reseau-proxy">Proxy</label>
        <input
          id="reseau-proxy"
          type="text"
          placeholder="http://proxy.example.com:3128"
          value={reglages.proxy}
          onChange={(e) => modifier({ proxy: e.currentTarget.value })}
        />
        {alerteProxy && <p className="panel__hint">{alerteProxy}</p>}
      </div>

      <div className="field">
        <label htmlFor="reseau-sans-proxy">Sans proxy</label>
        <input
          id="reseau-sans-proxy"
          type="text"
          placeholder="localhost,127.0.0.1,.entreprise.fr"
          value={reglages.sansProxy}
          onChange={(e) => modifier({ sansProxy: e.currentTarget.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="reseau-autorite">Autorité de certification (fichier .pem)</label>
        <input
          id="reseau-autorite"
          type="text"
          placeholder="/chemin/vers/entreprise.pem"
          value={reglages.autorite}
          onChange={(e) => modifier({ autorite: e.currentTarget.value })}
        />
        <p className="panel__hint">
          Nécessaire derrière un proxy qui inspecte le TLS : le moteur ne lit pas le magasin de
          certificats du système par défaut, et l'échec ressemble à « certificat auto-signé ».
        </p>
      </div>

      <div className="field field--inline">
        <input
          id="reseau-ca-systeme"
          type="checkbox"
          checked={reglages.caSysteme}
          onChange={(e) => modifier({ caSysteme: e.currentTarget.checked })}
        />
        <label htmlFor="reseau-ca-systeme">Lire aussi les certificats installés sur le système</label>
      </div>

      <div className="row">
        <button type="button" onClick={() => void enregistrer(true)}>
          Enregistrer et relancer le moteur
        </button>
        <button type="button" className="btn--ghost" onClick={() => void enregistrer(false)}>
          Enregistrer seulement
        </button>
      </div>
      {avis && <p className="panel__notice">{avis}</p>}

      <p className="panel__hint">
        Le fichier de configuration automatique (PAC) déclaré par Windows n'est <strong>pas</strong> lu :
        sur un poste qui n'a que ça, saisir l'adresse du proxy ici.
      </p>
    </section>
  );
}
