/*
 * Section « MCP » de la barre latérale de la page Projets — sortie
 * d'AgentPage.tsx (au plafond du cliquet de taille) quand la section
 * « Veilleur » est venue s'y ajouter. Elle porte son propre compteur de
 * serveurs : seul le badge s'en sert.
 */
import { useState } from "react";
import { McpPanel } from "./McpPanel";
import { SidebarSection } from "./SidebarSection";

export function McpSection({
  cwd,
  usage,
  reloadToken,
}: Readonly<{
  cwd: string;
  usage: Parameters<typeof McpPanel>[0]["usage"];
  reloadToken: number;
}>) {
  const [nombre, setNombre] = useState(0);
  return (
    <SidebarSection
      id="mcp"
      title="MCP"
      defaultOpen={false}
      badge={nombre > 0 ? <span className="sidebar-section__count">{nombre}</span> : undefined}
    >
      <McpPanel cwd={cwd} usage={usage} reloadToken={reloadToken} onServerCount={setNombre} />
    </SidebarSection>
  );
}
