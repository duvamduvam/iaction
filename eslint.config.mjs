// Analyse statique du front — volontairement MINIMALE : une seule règle, mais
// une règle qui a fait ses preuves ici. `react-hooks/rules-of-hooks` a trouvé
// en 30 secondes le plantage « Rendered fewer hooks than expected » du
// 2026-08-07 (retour anticipé au milieu des hooks d'AgentPage — l'écran
// d'accueil sans projet tuait toute l'interface), invisible au typecheck comme
// au build. On élargira si un autre incident le justifie ; on n'empile pas de
// règles de style pour le plaisir.
import parser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  // Rien d'autre que le code SOURCE du front : sans ces ignores, eslint
  // parcourt les artefacts de build Rust (src-tauri/target) et s'étrangle sur
  // leurs assets générés.
  { ignores: ["**/node_modules/**", "**/dist/**", "src-tauri/target/**", "build/**"] },
  {
    files: ["ui/src/**/*.ts", "ui/src/**/*.tsx"],
    languageOptions: {
      parser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
    },
    plugins: { "react-hooks": reactHooks },
    // Le code porte des `eslint-disable … exhaustive-deps` posés à dessein :
    // la règle n'est pas activée ici, mais ces commentaires documentent chaque
    // dérogation et serviront le jour où on l'activera. Ne pas les signaler
    // comme « inutilisés ».
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "react-hooks/rules-of-hooks": "error",
    },
  },
];
