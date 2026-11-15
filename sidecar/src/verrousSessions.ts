/*
 * Verrous par clé (T-180) : file d'attente par identifiant, clés différentes en
 * parallèle. Sert au verrou « une session distante, un échange à la fois »
 * (le flux d'une session ne se partage pas : deux échanges simultanés
 * liraient la réponse l'un de l'autre) et à l'ouverture d'un fil (deux appels
 * simultanés ne doivent pas créer deux sessions pour le même fil).
 */

export interface Verrous {
  /** Attend son tour sur `cle` ; rend la fonction qui libère. À appeler dans un `finally`. */
  prendre(cle: string): Promise<() => void>;
  /** Vrai si `cle` est déjà tenue ou attendue. */
  occupe(cle: string): boolean;
}

export function creerVerrous(): Verrous {
  const files = new Map<string, Promise<void>>();
  return {
    occupe: (cle) => files.has(cle),
    async prendre(cle) {
      const precedent = files.get(cle) ?? Promise.resolve();
      let liberer: () => void = () => undefined;
      const mien = new Promise<void>((resolve) => {
        liberer = resolve;
      });
      const queue = precedent.then(() => mien);
      files.set(cle, queue);
      await precedent;
      return () => {
        liberer();
        if (files.get(cle) === queue) files.delete(cle);
      };
    },
  };
}
