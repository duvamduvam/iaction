# Prototype d'avatar parlant (hors application)

Tête 3D à 52 poses ARKit qui **parle** et **change d'émotion** selon des
balises dans la réponse (`[joie] … [reflexion] …`). Page web autonome,
three.js chargé depuis le CDN : rien n'est branché dans IAction pour l'instant.
Étude et suite : `docs/etude-avatar.md`.

## Lancer

```bash
tools/avatar-proto/telecharger-modele.sh        # une fois : têtes d'essai (~55 Mo)
cd tools/avatar-proto && python3 -m http.server 8765
# puis ouvrir http://localhost:8765  (un serveur est obligatoire : modules ES)
```

`?modele=avaturn&emotion=joie` dans l'URL fixe le modèle et l'émotion de départ
(captures de vérification).

## Têtes d'essai (jamais versionnées)

| Modèle | Origine | Licence |
|---|---|---|
| `avaturn` (défaut) | Avaturn, d'après photos — femme réaliste | non commercial |
| `brunette` | Ready Player Me — style cartoon | CC BY-NC 4.0 |
| `mpfb` | MakeHuman / MPFB (Blender) | CC0 |
| `facecap` | exemple three.js — tête grise de test | exemple three.js |

Les trois premières viennent du dépôt TalkingHead (met4citizen) et portent
en plus les visèmes Oculus (`viseme_aa`…), utiles pour une bouche phonétique.

## Ce que ça montre

| Fonction | Fidélité |
|---|---|
| Émotions par balises ou boutons | 8 émotions, transitions lissées |
| Voix du navigateur | bouche **simulée** (l'API ne donne pas le son) |
| Fichier audio / miroir micro | bouche calée sur le **volume réel** |
| Vie au repos | clignements, saccades, balancement |
| Charger un GLB | toute tête ARKit 52 (MetaHuman exportée…) |

## Tests

```bash
node --test tools/avatar-proto/emotions.test.mjs
```
