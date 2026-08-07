/*
 * matchSendKeyword — le mot-clé d'envoi en fin de dictée.
 *
 * Chaque cas de ce fichier correspond à un comportement APPRIS À LA DURE face
 * aux réécritures de Whisper (voir l'en-tête de sendKeyword.ts) : graphies
 * instables, homophones, découpage « en voie », élisions, et les garde-fous
 * grammaticaux qui évitent d'envoyer au milieu d'une vraie phrase. Si un de
 * ces tests casse, c'est qu'une régression réintroduit un faux départ ou un
 * faux blocage constaté en usage réel.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SEND_KEYWORD, matchSendKeyword } from "./sendKeyword";

describe("mot-clé par défaut (« transmets »)", () => {
  it("déclenche en fin de phrase et retire le mot-clé du corps", () => {
    expect(matchSendKeyword("Voilà ma question, transmets.")).toEqual({
      body: "Voilà ma question",
      send: true,
    });
  });

  it("tolère les graphies de Whisper : sans « s », majuscules, accents parasites", () => {
    expect(matchSendKeyword("C'est bon transmet").send).toBe(true);
    expect(matchSendKeyword("C'est bon TRANSMETS !").send).toBe(true);
  });

  it("tolère la ponctuation fermante multiple", () => {
    expect(matchSendKeyword("C'est parti, transmets… »").send).toBe(true);
  });

  it("cas limite assumé : « vas-y transmets » est bloqué (le « y » est pronominal)", () => {
    // Le garde-fou grammatical lit le mot précédent lettre à lettre : dans
    // « vas-y », il voit « y », pronom de la liste. Philosophie du module :
    // strict sur la grammaire — on préfère ce faux blocage rare à un envoi
    // dans « je m'y transmets ». Documenté ici pour que le jour où quelqu'un
    // « corrige » ce comportement, il le fasse en connaissance de cause.
    expect(matchSendKeyword("vas-y transmets").send).toBe(false);
  });

  it("mot-clé seul : corps vide, envoi quand même", () => {
    expect(matchSendKeyword("Transmets.")).toEqual({ body: "", send: true });
  });

  it("ne déclenche PAS au milieu du texte", () => {
    expect(matchSendKeyword("transmets ce fichier à Paul").send).toBe(false);
  });

  it("ne déclenche PAS derrière un pronom (usage verbal réel)", () => {
    expect(matchSendKeyword("c'est le rapport que je te transmets").send).toBe(false);
  });

  it("garde la ponctuation de phrase mais retire la virgule de liaison", () => {
    expect(matchSendKeyword("Voilà. Transmets").body).toBe("Voilà.");
    expect(matchSendKeyword("Voilà, transmets").body).toBe("Voilà");
  });

  it("texte vide ou blanc : rien ne part", () => {
    expect(matchSendKeyword("")).toEqual({ body: "", send: false });
    expect(matchSendKeyword("   ").send).toBe(false);
  });
});

describe("famille « envoie » (mot-clé configuré fragile, mécanique dédiée)", () => {
  it("reconnaît les homophones réécrits par Whisper", () => {
    for (const fin of ["envoie", "envoi", "envoyer", "Envoie."]) {
      expect(matchSendKeyword(`ma question ${fin}`, "envoie").send).toBe(true);
    }
  });

  it("reconnaît le recollage élidé « l'envoi » (réécriture Whisper)", () => {
    const r = matchSendKeyword("ma question, l'envoi.", "envoie");
    expect(r.send).toBe(true);
    expect(r.body).toBe("ma question");
  });

  it("reconnaît la forme découpée « en voie » ([ɑ̃vwa] en deux mots)", () => {
    const r = matchSendKeyword("les régions souveraines en voie.", "envoie");
    expect(r.send).toBe(true);
    expect(r.body).toBe("les régions souveraines");
  });

  it("ne déclenche PAS sur les vraies tournures grammaticales", () => {
    expect(matchSendKeyword("que je t'envoie", "envoie").send).toBe(false);
    expect(matchSendKeyword("je l'envoie", "envoie").send).toBe(false);
    expect(matchSendKeyword("tu en vois", "envoie").send).toBe(false);
    expect(matchSendKeyword("j'en vois", "envoie").send).toBe(false);
  });
});

describe("mot-clé configuré quelconque", () => {
  it("comparaison normalisée, tolérance du « s » final", () => {
    expect(matchSendKeyword("c'est fini, valide", "valides").send).toBe(true);
    expect(matchSendKeyword("c'est fini, valides", "valide").send).toBe(true);
  });

  it("réglage à rallonge : seul le dernier mot compte", () => {
    expect(matchSendKeyword("ok envoi final", "envoi final").send).toBe(true);
  });

  it("réglage vide ou blanc : retombe sur le défaut", () => {
    expect(matchSendKeyword("bon, transmets", "  ").send).toBe(true);
    expect(DEFAULT_SEND_KEYWORD).toBe("transmets");
  });

  it("élision collée = vrai mot du texte, pas le mot-clé", () => {
    expect(matchSendKeyword("c'est l'unique", "unique").send).toBe(false);
  });
});
