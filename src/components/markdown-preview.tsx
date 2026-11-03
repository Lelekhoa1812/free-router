"use client";

import { useEffect, useId, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

function MermaidDiagram({ source }: { source: string }) {
  const id = `diagram-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [svg, setSvg] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setSvg("");
    setError(false);
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
        themeVariables: {
          darkMode: true,
          background: "#0b1114",
          primaryColor: "#172a24",
          primaryTextColor: "#e4eee8",
          primaryBorderColor: "#4b8d6b",
          lineColor: "#779486",
          secondaryColor: "#17202a",
          tertiaryColor: "#1c252b",
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        },
      });
      try {
        const result = await mermaid.render(id, source);
        if (active) setSvg(result.svg);
        else result?.bindFunctions?.(document.createElement("div"));
      } catch {
        if (active) setError(true);
      }
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [id, source]);

  if (error) return <div className="markdown-diagram-error"><span>Diagram couldn’t be rendered</span><pre>{source}</pre></div>;
  if (!svg) return <div className="markdown-diagram-loading" role="status">Rendering diagram…</div>;
  return <div className="markdown-diagram" role="img" aria-label="Rendered Mermaid diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function isCodeElement(node: ReactNode): node is ReactElement<{ className?: string; children?: ReactNode }> {
  return Boolean(node && typeof node === "object" && "props" in node && (node as ReactElement).type === "code");
}

const components: Components = {
  pre({ children }) {
    if (isCodeElement(children)) {
      const language = /language-(\w+)/.exec(children.props.className || "")?.[1];
      const source = String(children.props.children ?? "").replace(/\n$/, "");
      if (language === "mermaid") return <MermaidDiagram source={source} />;
      return <div className="markdown-code-frame">
        <div className="markdown-code-label"><span>{language || "code"}</span><span>Code</span></div>
        <pre>{children}</pre>
      </div>;
    }
    return <pre>{children}</pre>;
  },
  a({ href, children, ...props }) {
    const safeHref = href && /^(https?:|mailto:|#)/i.test(href) ? href : undefined;
    return <a href={safeHref} {...props} target={safeHref?.startsWith("http") ? "_blank" : undefined} rel={safeHref?.startsWith("http") ? "noreferrer" : undefined}>{children}</a>;
  },
};

export function MarkdownPreview({ content }: { content: string }) {
  return <div className="markdown-preview" aria-live="polite" aria-label="Formatted model response">
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components} skipHtml>
      {content}
    </ReactMarkdown>
  </div>;
}
