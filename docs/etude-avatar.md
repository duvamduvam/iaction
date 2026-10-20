# Étude — avatar parlant à émotions dans IAction

Ouverte le 2026-10-07. **État : prototype A0 fait** (`tools/avatar-proto/`),
rien n'est branché dans l'application.

## 1. Ce que David a tranché (07/10)

- La cible, c'est **IAction** (pas le robot Didier).
- L'avatar **parle** : la synthèse vocale fait partie du chantier.
- Il réagit à **quatre entrées** : le texte de la conversation, la voix de
  David, son visage (webcam) et les fichiers déposés.
- La tête sera une **MetaHuman** (Epic), avec rendu 3D local. Le
  photoréaliste en cloud (Tavus, Anam) n'est qu'un point de comparaison.

## 2. Architecture retenue

L'**état émotionnel** et le **rendu** sont séparés : le rendu doit pouvoir
changer (tête, moteur d'animation) sans toucher au reste.

| Entrée | Mécanisme | Où ça arrive |
|---|---|---|
| Texte de la conversation | le LLM émet des balises `[joie]`… dans sa réponse | balises → émotion |
| Fichiers déposés | contexte du LLM, **pas de canal propre** | via le texte |
| Visage de David | MediaPipe Face Landmarker, en local | contexte du LLM (« l'air agacé ») |
| Voix de David | Audio2Emotion ou équivalent | contexte du LLM |

Sur le visage, trois couches s'additionnent : émotion, bouche de parole et
vie au repos (clignements, saccades). Voir l'en-tête de `tools/avatar-proto/avatar.js`.

**Branchement de la voix.** `ui/src/audioPlayback.ts` joue déjà la synthèse
avec des `HTMLAudioElement`. On peut les brancher sur un `AnalyserNode`
(`createMediaElementSource`), exactement comme le mode « fichier audio » du
prototype. Ne pas dupliquer cette file de lecture : s'y brancher.

## 3. Lots

| Lot | Contenu | État |
|---|---|---|
| A0 | Prototype autonome : têtes ARKit (femme réaliste Avaturn par défaut), 8 émotions, balises, bouche sur le volume | ✅ 07/10 |
| A1 | Tête MetaHuman exportée en GLB à 52 poses, chargée dans A0, poids recalés | à faire |
| A2 | Panneau avatar dans IAction, bouche branchée sur `audioPlayback`, balises retirées du texte affiché et de la voix | à faire |
| A3 | Webcam (MediaPipe) et voix de David vers le contexte du LLM | à faire |
| A4 | Audio2Face-3D local (bouche fine + émotion vocale) à la place de la bouche au volume | à faire, GPU NVIDIA |

## 4. Faits vérifiés

- **Poste de dev** : RTX 4060 portable, 8 Go de mémoire vidéo (`nvidia-smi`,
  07/10). Cette mémoire est partagée avec Ollama : à mesurer avant A4.
- **MetaHuman** : utilisable hors Unreal (Blender, web…) depuis la 5.6
  (juin 2025). Gratuit sous 1 M$ de chiffre d'affaires. Le Creator vit
  désormais dans Unreal Engine, avec un support Linux depuis la 5.7.
  Sources : metahuman.com/license et digitalproduction.com (05/06/2025).
- **Raccourci pour A1** : une tête MetaHuman déjà extraite avec les 52 poses
  existe sur Gumroad (« MetaHuman Head – 52 blendshapes – ARkit ready »).
  ⚠️ Licence Epic à vérifier avant tout usage public.
- **Ready Player Me** a fermé le 31/01/2026 (rachat par Netflix) et Union
  Avatars en 07/2026. On garde les GLB en local et on ne dépend d'aucun
  service de création d'avatar.
- **Tavus** a une offre gratuite : 20 à 25 minutes de conversation vidéo
  selon les sources (baisse annoncée en 2026), puis facturation à la minute.
  Lu le 07/10 sur tavus.io/pricing et costbench.com. Assez pour comparer,
  pas pour un usage quotidien.

## 5. Constats du prototype (A0)

- Sur la tête Face Cap, les 8 émotions se distinguent. La **colère** et la
  **réflexion** restent faibles : poids à recaler sur la MetaHuman (A1),
  pas sur la tête de test.
- La voix du navigateur ne donne pas accès au son : sa bouche est simulée.
  Le prototype l'affiche honnêtement. En production, la bouche suit le son
  réel (A2), puis Audio2Face (A4).
- **Deux conventions de noms** pour les poses latéralisées : `mouthSmile_L`
  (ARKit, Face Cap) et `mouthSmileLeft` (Ready Player Me, Avaturn, MPFB).
  La première version ne connaissait que la première et ignorait **sans
  rien dire** sourire, sourcils et clignements sur les autres têtes : seule
  `jawOpen` bougeait. Résolu par `indexPose()` (testé). L'écran avertit
  désormais si les poses latéralisées sont introuvables. Point à surveiller
  pour l'export MetaHuman (A1).
- Femme réaliste par défaut (07/10, demande de David) : tête **Avaturn**
  du dépôt TalkingHead, usage non commercial seulement, donc solution
  d'attente avant la MetaHuman. Ses poses sont plus discrètes que celles de
  Face Cap : un curseur d'intensité (×1,4 par défaut) compense. Les cheveux
  sont des plaques à transparence, aux bords crénelés en rendu logiciel :
  à revoir sur le vrai GPU.
- Les têtes 3D (Face Cap, Avaturn, MetaHuman…) ne sont **jamais versionnées** : ce
  sont des licences de tiers (voir `tools/avatar-proto/.gitignore`).
