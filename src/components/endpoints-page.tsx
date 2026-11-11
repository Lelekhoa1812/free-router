"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowUpRight, BookOpen, Check, Clipboard, Code2, Cpu, ExternalLink, KeyRound, Layers3, MessageSquareText, Sparkles, Waypoints } from "lucide-react";
import { DOCUMENTED_EMBEDDING_POLICY, ENDPOINT_DOCS, type EndpointDoc } from "@/lib/endpoints-docs";
import { EMBEDDING_MODELS } from "@/lib/models/embedding-catalog";

type Section = "llm" | "decisions" | "embeddings";
type Language = "curl" | "typescript" | "python";

export function EndpointsPage() {
  const [section, setSection] = useState<Section>("llm");
  const [language, setLanguage] = useState<Language>("curl");
  const [copied, setCopied] = useState("");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);

  // Fetch base URL from public config API
  useEffect(() => {
    async function fetchBaseUrl() {
      try {
        const response = await fetch("/api/public/config", { cache: "no-store" });
        if (response.ok) {
          const data = await response.json();
          if (data.baseUrl) {
            setBaseUrl(data.baseUrl.replace(/\/$/, "") + "/v1");
          }
        }
      } catch {
        // Ignore errors, will use empty string
      } finally {
        setLoading(false);
      }
    }
    fetchBaseUrl();
  }, []);

  // Generate examples dynamically based on baseUrl
  const examples = useMemo(() => {
    const url = baseUrl || "https://your-deployment.vercel.app/v1";
    return {
      llm: {
        curl: `curl ${url}/chat/completions -H "Authorization: Bearer \$FREEROUTER_API_KEY" -H "Content-Type: application/json" -d '{"model":"fr-code","stream":true,"messages":[{"role":"user","content":"Explain this function."}]}'`,
        typescript: `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.FREEROUTER_API_KEY,
  baseURL: "${url}",
});

const stream = await client.chat.completions.create({
  model: "fr-code",
  stream: true,
  messages: [{ role: "user", content: "Explain this function." }],
});

for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");`,
        python: `from openai import OpenAI

client = OpenAI(
    api_key="<FREEROUTER_API_KEY>",
    base_url="${url}",
)

stream = client.chat.completions.create(
    model="fr-code",
    stream=True,
    messages=[{"role": "user", "content": "Explain this function."}],
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`,
      },
      decisions: {
        curl: `curl ${url}/decisions -H "Authorization: Bearer \$FREEROUTER_API_KEY" -H "Content-Type: application/json" -d '{"model":"jev/jev-latest","input":"The user asks to refactor a TypeScript service.","questions":[{"type":"choice","name":"task","options":[{"value":"code","label":"Write or change code"},{"value":"explain","label":"Explain existing code"}]}]}'`,
        typescript: `const response = await fetch("${url}/decisions", {
  method: "POST",
  headers: {
    Authorization: "Bearer <FREEROUTER_API_KEY>",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "jev/jev-latest",
    input: "The user asks to refactor a TypeScript service.",
    questions: [{ type: "choice", name: "task", options: [
      { value: "code", label: "Write or change code" },
      { value: "explain", label: "Explain existing code" },
    ] }],
  }),
});
const decision = await response.json();`,
        python: `import requests

response = requests.post(
    "${url}/decisions",
    headers={"Authorization": "Bearer <FREEROUTER_API_KEY>"},
    json={
        "model": "jev/jev-latest",
        "input": "The user asks to refactor a TypeScript service.",
        "questions": [{"type": "choice", "name": "task", "options": [
            {"value": "code", "label": "Write or change code"},
            {"value": "explain", "label": "Explain existing code"},
        ]}],
    },
)
print(response.json())`,
      },
      embeddings: {
        curl: `curl ${url}/embeddings -H "Authorization: Bearer \$FREEROUTER_API_KEY" -H "Content-Type: application/json" -d '{"model":"google/gemini-embedding-2","input":["A vector represents this sentence.","A second item can be embedded in the same call."]}'`,
        typescript: `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.FREEROUTER_API_KEY,
  baseURL: "${url}",
});

const result = await client.embeddings.create({
  // Choose one concrete embedding model from GET /v1/models?type=embedding.
  model: "google/gemini-embedding-2",
  input: ["A vector represents this sentence.", "A second item."],
});
console.log(result.data[0].embedding);`,
        python: `from openai import OpenAI

client = OpenAI(
    api_key="<FREEROUTER_API_KEY>",
    base_url="${url}",
)

result = client.embeddings.create(
    # Choose a concrete embedding model from GET /v1/models?type=embedding.
    model="google/gemini-embedding-2",
    input: ["A vector represents this sentence.", "A second item."],
)
print(len(result.data[0].embedding), result.data[0].index)`,
      },
    };
  }, [baseUrl]);

  const sections = [
    { id: "llm" as Section, label: "LLM APIs", eyebrow: "OPENAI-COMPATIBLE", title: "Generate with chat or Responses", detail: "Use a routing alias for eligible chat requests, or pin a provider-qualified model when you need a specific model contract.", icon: MessageSquareText },
    { id: "decisions" as Section, label: "Jev decisions", eyebrow: "DECISION MODELS", title: "Ask Jev to decide", detail: "Run named questions against evidence through either OpenAI Decisions or the native TypeSafe System One contract.", icon: Waypoints },
    { id: "embeddings" as Section, label: "Embeddings", eyebrow: "VECTOR REPRESENTATIONS", title: "Embed with a named model", detail: "Embedding models are selected explicitly by model ID. This endpoint never uses fr-auto or another routing alias.", icon: Layers3 },
  ];

  const current = sections.find((item) => item.id === section)!;
  const Icon = current.icon;

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(""), 1600);
    } catch {
      setCopied("Copy unavailable");
    }
  }

  return <div className="endpoints-page">
    <section className="endpoints-hero">
      <div className="endpoints-hero-copy">
        <span className="endpoints-eyebrow"><BookOpen size={13}/> API REFERENCE <span className="endpoints-eyebrow-dot"/> VERSION 1</span>
        <h1>One gateway.<br/><span>Three API surfaces.</span></h1>
        <p>Connect an OpenAI SDK or Cursor once, then use chat and Responses models, Jev decisions, and explicit vector embeddings with the same FreeRouter key.</p>
        <div className="endpoints-base-url"><div><small>BASE URL</small><code>{baseUrl || "https://your-deployment.vercel.app/v1"}</code></div><button className="endpoints-copy" onClick={() => void copy(baseUrl || "https://your-deployment.vercel.app/v1", "Base URL copied")} aria-label="Copy base URL"><Clipboard size={14}/></button></div>
      </div>
      <div className="endpoints-hero-visual" aria-hidden="true"><div className="api-orbit orbit-one"/><div className="api-orbit orbit-two"/><div className="api-core"><Cpu size={24}/></div><span className="api-node node-chat"><MessageSquareText size={15}/></span><span className="api-node node-jev"><Waypoints size={15}/></span><span className="api-node node-vector"><Layers3 size={15}/></span><span className="api-orbit-label label-chat">GENERATE</span><span className="api-orbit-label label-jev">DECIDE</span><span className="api-orbit-label label-vector">EMBED</span></div>
    </section>

    <div className="endpoints-content-grid">
      <aside className="endpoints-rail" aria-label="Endpoint documentation sections">
        <span className="endpoints-rail-label">REFERENCE</span>
        {sections.map(({ id, label, icon: ItemIcon }) => <button key={id} onClick={() => { setSection(id); setLanguage("curl"); }} className={`endpoint-rail-link ${id === section ? "active" : ""}`} aria-current={id === section ? "page" : undefined}><ItemIcon size={16}/><span>{label}</span><ArrowUpRight size={13}/></button>)}
        <div className="endpoints-rail-divider"/><a className="endpoint-rail-link external" href="https://platform.openai.com/docs/api-reference" target="_blank" rel="noreferrer"><ExternalLink size={15}/><span>OpenAI API reference</span></a>
        <div className="endpoints-auth-card"><KeyRound size={15}/><b>One client key</b><p>Send a generated key as a bearer token. Provider secrets stay server-side.</p></div>
      </aside>

      <main className="endpoints-main">
        <div className="endpoint-section-heading"><div className="endpoint-section-icon"><Icon size={18}/></div><div><span className="endpoints-eyebrow">{current.eyebrow}</span><h2>{current.title}</h2><p>{current.detail}</p></div></div>

        {section === "llm" && <div className="endpoint-note endpoint-note-blue"><Sparkles size={15}/><span><b>Cursor-ready:</b> set the OpenAI base URL to your deployment plus <code>/v1</code>, then select <code>fr-auto</code> or <code>fr-code</code>. Cursor's own Auto selector is separate. Chat and Responses use ordinary OpenAI-compatible request shapes.</span></div>}
        {section === "decisions" && <div className="endpoint-note endpoint-note-violet"><Waypoints size={15}/><span>Decision models are discovered separately from chat models. Jev does not stream; send <code>stream:false</code> or omit the field. The optional internal classifier is used only by <code>fr-auto</code> and never replaces the LLM answer.</span></div>}
        {section === "embeddings" && <div className="endpoint-note endpoint-note-green"><Layers3 size={15}/><span><b>Explicit model selection:</b> {DOCUMENTED_EMBEDDING_POLICY.autoRouted ? "This endpoint supports automatic routing." : "there is no embedding alias or automatic model routing."} Request one concrete embedding model ID from <code>{DOCUMENTED_EMBEDDING_POLICY.discoveryPath}</code>. Chat aliases such as <code>fr-auto</code> are not embedding models.</span></div>}

        <div className="endpoint-list-heading"><div><span className="endpoints-eyebrow">ENDPOINT DIRECTORY</span><h3>{section === "llm" ? "Chat & Responses" : section === "decisions" ? "Jev Decisions" : "Vector embeddings"}</h3></div><span className="endpoint-count">{ENDPOINT_DOCS[section].length} routes</span></div>
        <div className="endpoint-directory">{ENDPOINT_DOCS[section].map((endpoint) => <EndpointRow key={`${endpoint.method} ${endpoint.path}`} endpoint={endpoint} onCopy={copy} copied={copied}/>)}</div>

        <section className="endpoint-example panel">
          <div className="endpoint-example-head"><div><span className="endpoints-eyebrow">QUICKSTART</span><h3>{section === "llm" ? "Stream a chat completion" : section === "decisions" ? "Create a decision" : "Create a vector"}</h3></div><div className="endpoint-language-tabs" role="tablist" aria-label="Example language">{(["curl", "typescript", "python"] as const).map((lang) => <button key={lang} role="tab" aria-selected={language === lang} className={language === lang ? "active" : ""} onClick={() => setLanguage(lang)}>{lang === "typescript" ? "TypeScript" : lang === "python" ? "Python" : "cURL"}</button>)}</div></div>
          <div className="endpoint-code-wrap"><pre><code>{examples[section][language]}</code></pre><button className="endpoint-code-copy" onClick={() => void copy(examples[section][language], "Example copied")} aria-label="Copy example">{copied === "Example copied" ? <Check size={14}/> : <Clipboard size={14}/>}<span>{copied === "Example copied" ? "Copied" : "Copy"}</span></button></div>
        </section>

        <section className="endpoint-contract-grid">
          {section === "llm" ? <>
            <ContractCard icon={<Activity size={15}/>} title="Streaming & retries" body="FreeRouter streams from providers even when the client asks for a JSON response. SSE failures stay failures; fallback is allowed only before semantic output reaches the client." />
            <ContractCard icon={<Code2 size={15}/>} title="Tools & structured output" body="Function calls are returned for your client to execute. FreeRouter never runs your functions. Tool and strict-schema support depends on the certified model binding." />
            <ContractCard icon={<Layers3 size={15}/>} title="Responses state" body="previous_response_id is key-scoped and available for 24 hours. Set store:false for stateless requests; hosted tools, audio, files, and background mode are not supported." />
          </> : section === "decisions" ? <>
            <ContractCard icon={<Waypoints size={15}/>} title="Two wire contracts" body="Use /v1/decisions for OpenAI's ordered question format, or /v1/systemone for TypeSafe's native state and named questions. The same FreeRouter key works for both." />
            <ContractCard icon={<Activity size={15}/>} title="Jev credits & streaming" body="Calls consume the existing TypeSafe account credits. FreeRouter does not top up. Jev has no streaming contract; stream:true is rejected." />
            <ContractCard icon={<Code2 size={15}/>} title="Typed answers" body="Choice values preserve string and boolean types. Score answers preserve fractional expected-level values and confidence separately." />
          </> : <>
            <ContractCard icon={<Layers3 size={15}/>} title="Available model IDs" body="The certified catalog below lists every model FreeRouter can serve. Discovery is filtered by configured healthy credentials and this key's model policy. Use GET /v1/models?type=embedding for models available to you now." />
            <ContractCard icon={<Code2 size={15}/>} title="Inputs & model options" body="Send a non-empty text string or batch of strings. dimensions and encoding_format are supported where the selected provider allows them. NVIDIA models can require input_type=query or passage. Provider-specific modality, truncation, and quantized-vector extensions are not exposed in FreeRouter v1." />
            <ContractCard icon={<Activity size={15}/>} title="Vectors & consistency" body="The response contains indexed embedding objects and reported usage where supplied. Record the model ID and vector size with your index, and use the same model for document and query vectors." />
          </>}
        </section>

        {section === "embeddings" && <section className="endpoint-embedding-inventory" aria-label="Certified embedding models"><div className="endpoint-inventory-heading"><div><span className="endpoints-eyebrow">MODEL-SPECIFIC ROUTES</span><h3>Certified embedding models</h3><p>Exact IDs only. Current endpoint availability depends on healthy provider credentials.</p></div><span>{EMBEDDING_MODELS.filter((model) => model.status === "ready").length} models</span></div><div className="endpoint-embedding-grid">{EMBEDDING_MODELS.filter((model) => model.status === "ready").map((model) => <article className="endpoint-embedding-model" key={model.id}><div><b>{model.label}</b><span className={`endpoint-provider-tag provider-${model.provider}`}>{model.provider}</span></div><code>{model.id}</code><p>{model.dimensions.minimum === model.dimensions.maximum ? `${model.dimensions.default} dimensions` : `${model.dimensions.minimum}–${model.dimensions.maximum} dimensions`}{model.inputType === "required" ? " · query or passage required" : model.inputType === "optional" ? " · query/passage optional" : " · text input"}</p></article>)}</div><p className="endpoint-inventory-footnote">Nemotron VL entries currently accept text only through FreeRouter. Choose the same model and retrieval mode for indexed passages and search queries.</p></section>}

        <section className="endpoint-errors panel"><div><span className="endpoints-eyebrow">COMMON BEHAVIOR</span><h3>Authentication, limits & errors</h3></div><div className="endpoint-error-content"><div><b>Bearer authentication</b><p>All public API routes require <code>Authorization: Bearer sk-fr-…</code>. Dashboard login cookies do not authorize API calls. Responses are <code>Cache-Control: no-store</code>.</p></div><div><b>Request limits</b><p>JSON request bodies are limited to 4 MiB. Output allowance defaults to 8,192 tokens and is bounded by the selected model profile. Quota limits return HTTP 429 with <code>Retry-After</code>.</p></div><div><b>Stable error envelope</b><p>Errors include an OpenAI-style <code>error</code> object with a stable code and request ID. Expect 400 invalid input, 401 invalid key, 403 scope/model denial, 404 unknown model/resource, 429 quota, 502 invalid upstream output, or 503 unavailable service.</p></div></div></section>
        <footer className="endpoint-footer"><span>FreeRouter API · v1</span><span>Use <code>GET /v1/models</code> to discover the models allowed for your key.</span><a href="https://github.com/Lelekhoa1812/free-router/blob/main/docs/API_CONTRACTS.md" target="_blank" rel="noreferrer">Full API contract <ExternalLink size={12}/></a>{section === "embeddings" && <a href="https://github.com/Lelekhoa1812/free-router/blob/main/docs/EMBEDDINGS.md" target="_blank" rel="noreferrer">Provider probe report <ExternalLink size={12}/></a>}</footer>
      </main>
    </div>
  </div>;
}

function EndpointRow({ endpoint, onCopy, copied }: { endpoint: EndpointDoc; onCopy: (text: string, label: string) => Promise<void>; copied: string }) {
  return <article className="endpoint-row"><span className={`endpoint-method method-${endpoint.method.toLowerCase()}`}>{endpoint.method}</span><div className="endpoint-row-main"><div className="endpoint-route-title"><code>{endpoint.path}</code><button aria-label={`Copy ${endpoint.path}`} onClick={() => void onCopy(endpoint.path, `${endpoint.path} copied`)}>{copied === `${endpoint.path} copied` ? <Check size={12}/> : <Clipboard size={12}/>}</button></div><b>{endpoint.title}</b><p>{endpoint.description}</p></div><span className="endpoint-auth-label">{endpoint.auth === "client" ? `${endpoint.scope ?? "API"} scope` : "Admin"}</span></article>;
}

function ContractCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return <article className="endpoint-contract-card"><span>{icon}</span><div><b>{title}</b><p>{body}</p></div></article>;
}