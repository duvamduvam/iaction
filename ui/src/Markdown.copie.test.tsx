import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, texteDuBloc } from "./Markdown";

describe("T-199 — copie d'un bloc de code", () => {
  it("retire seulement le saut de ligne final", () => {
    expect(texteDuBloc("ls -l\n")).toBe("ls -l");
    expect(texteDuBloc("a\n\nb\n\n")).toBe("a\n\nb\n");
    expect(texteDuBloc("sans fin")).toBe("sans fin");
    expect(texteDuBloc(null)).toBe("");
  });

  it("pose un bouton sur un bloc, pas sur du code en ligne", () => {
    const bloc = renderToStaticMarkup(<Markdown content={"```\nls -l\n```"} />);
    expect(bloc).toContain("md__copier");
    expect(bloc).toContain("ls -l");
    expect(renderToStaticMarkup(<Markdown content={"voir `ls`"} />)).not.toContain("md__copier");
  });

  it("garde le bouton hors du pre, qui défile", () => {
    const bloc = renderToStaticMarkup(<Markdown content={"```\nls\n```"} />);
    expect(bloc.indexOf("</pre>")).toBeLessThan(bloc.indexOf("md__copier"));
  });
});
