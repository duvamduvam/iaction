/*
 * Émotions de l'avatar → poids des 52 poses ARKit (« blendshapes »).
 *
 * Module PUR (aucun accès à three.js ni au DOM) pour rester testable sous
 * Node : c'est ici que vit le contrat « émotion → visage », le rendu ne fait
 * qu'appliquer des poids.
 *
 * Les noms de poses sont ceux d'ARKit, partagés par la tête de test Face Cap
 * et par les têtes MetaHuman exportées « 52 blendshapes ». Une pose absente
 * du modèle chargé est simplement ignorée par le rendu.
 *
 * Valeurs choisies à l'œil, volontairement modérées : au-delà de ~0,8 la
 * tête de test grimace. À recaler sur la tête MetaHuman une fois chargée.
 */

export const EMOTIONS = {
  neutre: {},
  joie: {
    mouthSmile_L: 0.7, mouthSmile_R: 0.7,
    cheekSquint_L: 0.4, cheekSquint_R: 0.4,
    eyeSquint_L: 0.3, eyeSquint_R: 0.3,
    browOuterUp_L: 0.15, browOuterUp_R: 0.15,
  },
  tristesse: {
    browInnerUp: 0.7,
    mouthFrown_L: 0.55, mouthFrown_R: 0.55,
    mouthShrugLower: 0.3,
    eyeLookDown_L: 0.25, eyeLookDown_R: 0.25,
  },
  colere: {
    browDown_L: 0.8, browDown_R: 0.8,
    noseSneer_L: 0.4, noseSneer_R: 0.4,
    mouthPress_L: 0.4, mouthPress_R: 0.4,
    eyeSquint_L: 0.35, eyeSquint_R: 0.35,
  },
  surprise: {
    browInnerUp: 0.8,
    browOuterUp_L: 0.8, browOuterUp_R: 0.8,
    eyeWide_L: 0.7, eyeWide_R: 0.7,
    jawOpen: 0.2,
  },
  peur: {
    browInnerUp: 0.9,
    eyeWide_L: 0.8, eyeWide_R: 0.8,
    mouthStretch_L: 0.5, mouthStretch_R: 0.5,
  },
  degout: {
    noseSneer_L: 0.8, noseSneer_R: 0.8,
    mouthUpperUp_L: 0.5, mouthUpperUp_R: 0.5,
    browDown_L: 0.4, browDown_R: 0.4,
  },
  // Asymétrique exprès : un sourcil qui travaille seul lit « je réfléchis ».
  reflexion: {
    browDown_L: 0.35,
    browOuterUp_R: 0.3,
    eyeLookUp_L: 0.35, eyeLookUp_R: 0.35,
    mouthPucker: 0.25,
    mouthLeft: 0.2,
  },
};

/** Accents et casse retirés : « Colère », « colere » et « COLÈRE » se valent. */
function normaliser(nom) {
  return nom.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/**
 * Découpe une réponse balisée en segments { emotion, texte }.
 *
 * Format attendu du LLM : « [joie] Super ! [reflexion] Voyons ça… ».
 * Le texte avant la première balise garde l'émotion `initiale`. Une balise
 * inconnue n'est PAS lue à voix haute (sinon l'avatar dirait « crochet
 * perplexe ») : elle est retirée et l'émotion courante est conservée.
 */
export function decouperBalises(reponse, initiale = "neutre") {
  const segments = [];
  let emotion = initiale;
  const motif = /\[([^\]]+)\]/g;
  let debut = 0;
  let m;
  const pousser = (texte) => {
    const propre = texte.replace(/\s+/g, " ").trim();
    if (propre) segments.push({ emotion, texte: propre });
  };
  while ((m = motif.exec(reponse)) !== null) {
    pousser(reponse.slice(debut, m.index));
    const nom = normaliser(m[1]);
    if (nom in EMOTIONS) emotion = nom;
    debut = motif.lastIndex;
  }
  pousser(reponse.slice(debut));
  return segments;
}

/**
 * Interpolation exponentielle d'un jeu de poids vers une cible.
 * `dt` en secondes, `vitesse` en 1/s (≈ 1/constante de temps). Les poses
 * absentes de la cible retombent vers 0 : changer d'émotion efface l'ancienne.
 */
export function rapprocher(courant, cible, dt, vitesse = 6) {
  const k = 1 - Math.exp(-vitesse * dt);
  const noms = new Set([...Object.keys(courant), ...Object.keys(cible)]);
  const suivant = {};
  for (const nom of noms) {
    const a = courant[nom] ?? 0;
    const b = cible[nom] ?? 0;
    const v = a + (b - a) * k;
    if (Math.abs(v) > 1e-3 || b !== 0) suivant[nom] = v;
  }
  return suivant;
}

/**
 * Index d'une pose ARKit dans le dictionnaire de poses d'un maillage.
 *
 * Deux conventions coexistent pour les poses latéralisées : ARKit/Face Cap
 * écrivent `mouthSmile_L`, Ready Player Me/Avaturn/MPFB `mouthSmileLeft`.
 * Sans cette résolution, sourire, sourcils et clignements sont IGNORÉS EN
 * SILENCE sur ces têtes (vécu le 07/10 : seule jawOpen bougeait).
 */
export function indexPose(dictionnaire, nom) {
  if (nom in dictionnaire) return dictionnaire[nom];
  const alt = nom.replace(/_L$/, "Left").replace(/_R$/, "Right");
  return alt in dictionnaire ? dictionnaire[alt] : undefined;
}
