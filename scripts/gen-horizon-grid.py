#!/usr/bin/env python3
"""Fonds « courbure d'espace-temps » pour IAction — 4 variantes Neon Drive.

Palette tirée de la référence neondrivegame.com : soleil rayé orange→rouge→
magenta, triangle rose néon, ambiance violette profonde, cyan en accent.
Toutes les variantes partagent la grille en perspective déformée par un puits
de gravité ; elles diffèrent par l'objet posé à l'horizon et le dégradé des
lignes. La variante livrée dans ui/public/horizon-grid.svg est « v2-orbe »
(choix utilisateur du 2026-07-21) — régénérer avec :
    python3 scripts/gen-horizon-grid.py ui/public && mv ui/public/v2-orbe.svg ui/public/horizon-grid.svg Dégradés de trait en userSpaceOnUse (objectBoundingBox s'effondre sur
les polylignes quasi horizontales).
"""
import math
import sys

W, H = 1600.0, 900.0
YH = 300.0
CX = 800.0
NR = 24
NU = 14
COL_W = 115.0
# Vue rasante (retour utilisateur : « les yeux à quelques centimètres
# au-dessus de la grille ») : l'exposant P écrase fortement les rangées vers
# l'horizon et les étale au premier plan.
P = 2.6
# Pas de point de fuite unique (retour utilisateur, cf. photo de référence
# « courbure d'espace-temps ») : la grille garde une largeur finie à
# l'horizon — SMIN est l'échelle horizontale résiduelle des colonnes au
# loin, 1.0 au premier plan. Les colonnes s'écartent en éventail doux au
# lieu de converger en un point.
SMIN = 0.45

# Puits de gravité — défini en ESPACE ÉCRAN et non en coordonnées de grille :
# la perspective écrase l'axe profondeur, un puits gaussien exprimé en (u, z)
# ressortait étiré vers l'horizon (creux « pointant vers le fond »). En écran,
# la cuvette reste ronde quel que soit l'endroit où elle se pose.
U0, Z0 = 2.2, 0.6  # position du centre du puits, en coordonnées grille
RW, RY = 390.0, 300.0  # rayons écran du puits (x / y)
DEPTH = 225.0  # enfoncement max, px écran
PULL = 0.15  # attraction horizontale des lignes vers l'axe du puits
ORB_R = 175.0  # rayon de la sphère posée dans la cuvette


def t_of(z):
    return z ** P


def project0(u, z):
    """Projection de la grille plane, sans déformation du puits."""
    t = t_of(z)
    s = SMIN + (1.0 - SMIN) * t
    return CX + u * COL_W * s, YH + (H - YH) * t


WX, WY = project0(U0, Z0)  # centre écran du puits


def deform(x, y, well=1.0):
    """Cuvette gaussienne en espace écran, enfoncement vertical uniforme.

    L'enveloppe `e` annule la déformation à l'approche de l'horizon : les
    rangées y sont espacées de quelques pixels, le moindre décalage les
    ferait se croiser.
    """
    rx = (x - WX) / RW
    ry = (y - WY) / RY
    g = math.exp(-(rx * rx + ry * ry)) * well
    e = min(1.0, max(0.0, (y - YH) / (WY - YH))) ** 1.6
    return x - (x - WX) * PULL * g * e, y + DEPTH * g * e


def project(u, z, well=1.0):
    x, y = project0(u, z)
    return deform(x, y, well)


def pts(seq):
    return " ".join(f"{x:.1f},{y:.1f}" for x, y in seq)


def line_gradient(stops):
    s = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in stops)
    return (
        f'<linearGradient id="line" gradientUnits="userSpaceOnUse" '
        f'x1="0" y1="{YH:.0f}" x2="0" y2="{H:.0f}">{s}</linearGradient>'
    )


def grid(well=1.0):
    out = []
    for i in range(1, NR + 1):
        z = i / NR
        t = t_of(z)
        samples = [project(-NU + (2 * NU) * k / 72, z, well) for k in range(73)]
        out.append(
            f'<polyline points="{pts(samples)}" fill="none" stroke="url(#line)" '
            f'stroke-width="{0.6 + 1.4 * t:.2f}" stroke-opacity="{0.35 + 0.55 * t:.2f}"/>'
        )
    for j in range(-NU, NU + 1):
        samples = [project(j, 0.02 + 0.98 * k / 48, well) for k in range(49)]
        out.append(
            f'<polyline points="{pts(samples)}" fill="none" stroke="url(#line)" '
            'stroke-width="1.0" stroke-opacity="0.55"/>'
        )
    return "".join(out)


def sky(top, mid):
    return (
        '<radialGradient id="sky" cx="0.5" cy="1" r="1.05">'
        f'<stop offset="0" stop-color="{top}" stop-opacity="0.34"/>'
        f'<stop offset="0.45" stop-color="{mid}" stop-opacity="0.15"/>'
        f'<stop offset="1" stop-color="{mid}" stop-opacity="0"/>'
        "</radialGradient>"
        f'<rect x="0" y="0" width="{W:.0f}" height="{YH:.0f}" fill="url(#sky)"/>'
    )


def horizon_line(color):
    return (
        f'<line x1="0" y1="{YH:.0f}" x2="{W:.0f}" y2="{YH:.0f}" '
        f'stroke="{color}" stroke-width="1.4" stroke-opacity="0.6"/>'
    )


def striped_sun(r=230.0, cx=CX, cy=YH):
    """Soleil synthwave : disque orange→rouge→magenta coupé de bandes
    horizontales qui s'épaississent vers le bas, tronqué à l'horizon."""
    grad = (
        '<linearGradient id="sun" x1="0" y1="0" x2="0" y2="1">'
        '<stop offset="0" stop-color="#ffd23f"/>'
        '<stop offset="0.35" stop-color="#ff8c00"/>'
        '<stop offset="0.62" stop-color="#ff3d54"/>'
        '<stop offset="1" stop-color="#ff2e97"/>'
        "</linearGradient>"
    )
    # Masque : blanc partout, bandes noires (les coupes) de plus en plus
    # épaisses vers le bas du disque.
    bands = []
    y = cy - r * 0.28
    gap, step = 4.0, 30.0
    while y < cy:
        bands.append(f'<rect x="{cx - r:.0f}" y="{y:.1f}" width="{2 * r:.0f}" height="{gap:.1f}" fill="black"/>')
        y += step
        gap *= 1.45
        step *= 0.98
    mask = (
        '<mask id="suncut">'
        f'<rect x="{cx - r:.0f}" y="{cy - r:.0f}" width="{2 * r:.0f}" height="{r:.0f}" fill="white"/>'
        + "".join(bands)
        + "</mask>"
    )
    halo = (
        '<radialGradient id="sunhalo" cx="0.5" cy="0.5" r="0.5">'
        '<stop offset="0" stop-color="#ff8c00" stop-opacity="0.5"/>'
        '<stop offset="0.6" stop-color="#ff3d54" stop-opacity="0.18"/>'
        '<stop offset="1" stop-color="#ff2e97" stop-opacity="0"/>'
        "</radialGradient>"
    )
    body = (
        f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="{r * 1.55:.0f}" fill="url(#sunhalo)"/>'
        f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="{r:.0f}" fill="url(#sun)" mask="url(#suncut)"/>'
    )
    return grad + mask + halo, body


def orb():
    """Sphère coucher-de-soleil posée dans la cuvette du puits.

    Le fond de la cuvette est à (WX, WY + DEPTH) ; la sphère y repose,
    bien enfoncée. Translucide (retour utilisateur) : la grille déformée se
    devine à travers la masse — un liseré magenta redonne son bord au globe.
    """
    ox = WX
    oy = WY + DEPTH - ORB_R + 45.0
    defs = (
        '<radialGradient id="halo" cx="0.5" cy="0.5" r="0.5">'
        '<stop offset="0" stop-color="#ff2e97" stop-opacity="0.5"/>'
        '<stop offset="0.45" stop-color="#a855f7" stop-opacity="0.2"/>'
        '<stop offset="1" stop-color="#a855f7" stop-opacity="0"/>'
        "</radialGradient>"
        '<linearGradient id="orb" x1="0" y1="0" x2="0" y2="1">'
        '<stop offset="0" stop-color="#ffd23f"/>'
        '<stop offset="0.38" stop-color="#ff8c00"/>'
        '<stop offset="0.7" stop-color="#ff3d54"/>'
        '<stop offset="1" stop-color="#c81d78"/>'
        "</linearGradient>"
    )
    body = (
        f'<circle cx="{ox:.0f}" cy="{oy:.0f}" r="{ORB_R * 1.9:.0f}" fill="url(#halo)"/>'
        f'<circle cx="{ox:.0f}" cy="{oy:.0f}" r="{ORB_R:.0f}" fill="url(#orb)" fill-opacity="0.55" '
        'stroke="#ff2e97" stroke-width="2" stroke-opacity="0.75"/>'
    )
    return defs, body


def triangle():
    """Triangle néon rose, pointe au-dessus de l'horizon, léger halo."""
    ax, ay = CX, 60.0
    half, by = 300.0, YH + 170.0
    path = f"M {ax - half:.0f} {by:.0f} L {ax:.0f} {ay:.0f} L {ax + half:.0f} {by:.0f} Z"
    return "", (
        f'<path d="{path}" fill="none" stroke="#ff2ef5" stroke-width="14" stroke-opacity="0.10" stroke-linejoin="round"/>'
        f'<path d="{path}" fill="none" stroke="#ff2ef5" stroke-width="7" stroke-opacity="0.30" stroke-linejoin="round"/>'
        f'<path d="{path}" fill="none" stroke="#ff9df5" stroke-width="2.4" stroke-opacity="0.9" stroke-linejoin="round"/>'
    )


VARIANTS = {
    # V1 — soleil rayé plein axe, grille rouge→magenta→violet→cyan
    "v1-soleil": {
        "stops": [(0, "#ff3d54"), (0.35, "#ff2e97"), (0.65, "#a855f7"), (1, "#00e5ff")],
        "sky_c": ("#ff5e3a", "#a855f7"),
        "objs": ["sun"],
        "well": 0.55,
        "horizon": "#ff3d54",
    },
    # V2 — orbe gravitationnel « coucher de soleil », dégradé complet
    "v2-orbe": {
        "stops": [(0, "#ff8c42"), (0.3, "#ff3d54"), (0.55, "#ff2e97"), (0.8, "#a855f7"), (1, "#00e5ff")],
        "sky_c": ("#ff8c42", "#a855f7"),
        "objs": ["orb"],
        "well": 1.0,
        "horizon": "#ff5e3a",
    },
    # V3 — triangle néon sur soleil rayé (l'icône Neon Drive)
    "v3-triangle": {
        "stops": [(0, "#ff3d54"), (0.35, "#ff2e97"), (0.65, "#a855f7"), (1, "#00e5ff")],
        "sky_c": ("#ff5e3a", "#a855f7"),
        "objs": ["sun", "triangle"],
        "well": 0.55,
        "horizon": "#ff3d54",
    },
    # V4 — épuré : grille seule aux couleurs du thème, puits marqué
    "v4-epure": {
        "stops": [(0, "#ff2e97"), (0.5, "#a855f7"), (1, "#00e5ff")],
        "sky_c": ("#ff2e97", "#a855f7"),
        "objs": [],
        "well": 1.0,
        "horizon": "#ff2e97",
    },
}

OBJ_FNS = {"sun": striped_sun, "orb": orb, "triangle": triangle}

outdir = sys.argv[1] if len(sys.argv) > 1 else "."
for name, v in VARIANTS.items():
    defs = [line_gradient(v["stops"])]
    bodies = []
    for o in v["objs"]:
        d, b = OBJ_FNS[o]()
        defs.append(d)
        bodies.append(b)
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}" '
        'preserveAspectRatio="xMidYMax slice">'
        f"<defs>{''.join(defs)}</defs>"
        + sky(*v["sky_c"])
        + (bodies[0] if "sun" in v["objs"] else "")
        + horizon_line(v["horizon"])
        + grid(v["well"])
        + "".join(b for o, b in zip(v["objs"], bodies) if o != "sun")
        + "</svg>"
    )
    path = f"{outdir}/{name}.svg"
    with open(path, "w") as f:
        f.write(svg)
    print(f"{path} : {len(svg)} octets")
