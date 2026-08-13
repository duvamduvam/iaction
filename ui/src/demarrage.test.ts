/*
 * Jalons de démarrage : deux propriétés, et ce sont elles qui rendent la
 * mesure crédible.
 *
 * 1. Un jalon ne part qu'UNE fois — sinon le `StrictMode` de développement
 *    (double montage) ou un rechargement à chaud écriraient un second
 *    « premier rendu » des minutes après le lancement, et le journal
 *    raconterait un démarrage qui n'a jamais eu lieu.
 * 2. Un envoi qui échoue ne remonte rien — une instrumentation qui casse
 *    l'application qu'elle observe est pire que pas d'instrumentation.
 */

import { describe, expect, it } from "vitest";

import { creerJalonneur, type JalonUi } from "./demarrage";

describe("creerJalonneur", () => {
  it("envoie chaque jalon, une seule fois", () => {
    const envoyes: JalonUi[] = [];
    const poser = creerJalonneur((etape) => envoyes.push(etape));

    poser("ui:script");
    poser("ui:premier-rendu");
    poser("ui:script");
    poser("ui:premier-rendu");

    expect(envoyes).toEqual(["ui:script", "ui:premier-rendu"]);
  });

  it("date chaque jalon sur l'horloge de la page, en millisecondes entières", () => {
    const dates: number[] = [];
    let horloge = 1234.56;
    const poser = creerJalonneur((_etape, pageMs) => dates.push(pageMs), () => horloge);

    poser("ui:script");
    horloge = 1300.4;
    poser("ui:premier-rendu");

    expect(dates).toEqual([1235, 1300]);
  });

  it("avale l'échec de l'envoi au lieu de le propager à l'appelant", () => {
    const poser = creerJalonneur(() => {
      throw new Error("hors Tauri");
    });

    expect(() => poser("ui:script")).not.toThrow();
  });
});
