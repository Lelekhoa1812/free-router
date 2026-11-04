export type PlaygroundProtocol = "decisions" | "systemone";
export type PlaygroundQuestionType = "predicate" | "choice" | "score";
export type EmbeddingEncoding = "float" | "base64";
export type PlaygroundServiceModel = { id: string; name?: string; provider?: string; dimensions?: number; status?: string; [key: string]: unknown };

export function extractPlaygroundModels(value: unknown): PlaygroundServiceModel[] {
  const rows = Array.isArray(value) ? value : typeof value === "object" && value !== null
    ? ((value as any).data || (value as any).models || (value as any).items || []) : [];
  return Array.isArray(rows) ? rows.filter((item): item is PlaygroundServiceModel => Boolean(item && typeof item.id === "string")) : [];
}

export function buildDecisionPlaygroundBody(protocol: PlaygroundProtocol, model: string, evidence: string, question: string, type: PlaygroundQuestionType = "predicate", options: string[] = ["No", "Yes"]) {
  if (protocol === "decisions") {
    const decisionQuestion = type === "choice"
      ? { type, instructions: question, choices: options.map((value) => ({ value, description: value })) }
      : type === "score"
        ? { type, instructions: question, levels: options.map((label) => ({ label })) }
        : { type, instructions: question };
    return { model, input: evidence, questions: [decisionQuestion] };
  }
  const nativeQuestion = type === "choice"
    ? { type, instructions: question, criteria: Object.fromEntries(options.map((value, index) => [`option_${index + 1}`, value])) }
    : type === "score"
      ? { type, instructions: question, criteria: options }
      : { type: "noul", instructions: question };
  return {
    model: model.replace(/^jev\//, ""),
    state: evidence,
    questions: { prioritize_hotfix: nativeQuestion },
  };
}

export function buildEmbeddingPlaygroundInput(value: string, mode: "single" | "lines"): string | string[] {
  return mode === "single" ? value : value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function buildEmbeddingPlaygroundBody(model: string, input: string | string[], encoding: EmbeddingEncoding, dimensions: string) {
  if (!model || model.startsWith("fr-")) throw new Error("Choose a concrete embedding model; aliases are not supported.");
  if (!input || (Array.isArray(input) && input.length === 0)) throw new Error("Enter at least one input text.");
  const body: { model: string; input: string | string[]; encoding_format: EmbeddingEncoding; dimensions?: number } = { model, input, encoding_format: encoding };
  if (dimensions.trim()) {
    const parsedDimensions = Number(dimensions);
    if (!Number.isInteger(parsedDimensions) || parsedDimensions < 1) throw new Error("Dimensions must be a positive whole number.");
    body.dimensions = parsedDimensions;
  }
  return body;
}
