import { env } from "@/lib/env";

type InstructionPart = { type: string; [key: string]: unknown };
type ChoiceValue = string | boolean;
type ChoiceOption = { value: ChoiceValue; description?: string };
type ScoreLevel = { label: string; description?: string };

export interface DecisionQuestion {
  type: "predicate" | "choice" | "score";
  name?: string;
  instructions: string | InstructionPart[];
  choices?: ChoiceOption[];
  levels?: ScoreLevel[];
}

const MODELS = new Set(["jev/jev-latest", "jev/jev-preview", "jev-latest", "jev-preview"]);
const REQUEST_FIELDS = new Set(["model", "input", "questions", "stream", "prompt_cache_key", "prompt_cache_options", "safety_identifier"]);

function fail(message: string): never {
  throw new Error(message);
}

function validateCacheFields(input: any) {
  // OpenAI accepts these on Decisions requests. Jev has no equivalent control, so
  // they are validated for shape and then deliberately not forwarded upstream.
  if (input.prompt_cache_key !== undefined && (typeof input.prompt_cache_key !== "string" || input.prompt_cache_key.length > 64)) {
    fail("prompt_cache_key must be a string of at most 64 characters");
  }
  if (input.prompt_cache_options !== undefined) {
    const options = input.prompt_cache_options;
    if (!options || typeof options !== "object" || Array.isArray(options)) fail("prompt_cache_options must be an object");
    const unknown = Object.keys(options).find((key) => key !== "mode" && key !== "ttl");
    if (unknown) fail(`Unsupported prompt_cache_options field: ${unknown}`);
    if (options.mode !== undefined && options.mode !== "implicit" && options.mode !== "explicit") {
      fail("prompt_cache_options.mode must be implicit or explicit");
    }
    if (options.ttl !== undefined && options.ttl !== "30m") fail("prompt_cache_options.ttl only supports 30m");
  }
  if (input.safety_identifier !== undefined && (typeof input.safety_identifier !== "string" || input.safety_identifier.length > 128)) {
    fail("safety_identifier must be a string of at most 128 characters");
  }
}

function validateInstructions(value: unknown, name: string | null): string | InstructionPart[] {
  const label = name === null ? "Question" : `Question ${name}`;
  if (typeof value === "string") {
    if (!value.trim()) fail(`${label} requires instructions`);
    return value;
  }
  if (!Array.isArray(value) || value.length === 0) fail(`${label} requires instructions as text or content parts`);
  for (const part of value as any[]) {
    if (!part || typeof part !== "object" || Array.isArray(part) || typeof part.type !== "string") {
      fail(`${label} has an invalid instruction part`);
    }
    if (part.type === "input_image") fail("Image decision evidence is not enabled");
    if (part.type === "input_text" && typeof part.text !== "string") fail(`${label} has an invalid input_text part`);
    if (part.type === "input_json" && !("data" in part)) fail(`${label} has an invalid input_json part`);
    if (part.type !== "input_text" && part.type !== "input_json") {
      fail(`${label} has an unsupported instruction part type: ${part.type}`);
    }
  }
  return value as InstructionPart[];
}

export function decisionToSystemOne(input: any) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Decision request must be an object");
  const unknown = Object.keys(input).find((key) => !REQUEST_FIELDS.has(key));
  if (unknown) fail(`Unsupported Decisions field: ${unknown}`);

  const requestedModel = String(input.model || "jev/jev-latest");
  if (!MODELS.has(requestedModel)) fail("Use a Jev model ID: jev/jev-latest or jev/jev-preview");
  validateCacheFields(input);

  if (input.input === undefined || input.input === null) fail("input is required");
  if (typeof input.input !== "string" && !Array.isArray(input.input)) fail("input must be a string or an array of input items");

  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 400) {
    fail("questions must contain between 1 and 400 entries");
  }

  const maps: Record<string, any> = {};
  const questions: Record<string, any> = {};

  input.questions.forEach((q: any, index: number) => {
    const id = `q${index}`;
    if (!q || typeof q !== "object" || Array.isArray(q)) fail(`Question at position ${index} must be an object`);
    if (q.type !== "predicate" && q.type !== "choice" && q.type !== "score") {
      fail(`Unsupported decision question type for question at position ${index}`);
    }
    if (q.name !== undefined && typeof q.name !== "string") fail("Question name must be a string");
    const name: string | null = q.name ?? null;
    const label = name === null ? `question at position ${index}` : `question ${name}`;
    const instructions = validateInstructions(q.instructions, name);
    maps[id] = { name, type: q.type, nativeType: q.type === "predicate" ? "noul" : q.type };

    if (q.type === "predicate") {
      questions[id] = { type: "noul", instructions };
      return;
    }

    if (q.type === "choice") {
      if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 255) {
        fail(`Choice ${label} must have 2–255 choices`);
      }
      const seen = new Set<string>();
      const criteria: Record<string, string> = {};
      maps[id].choices = {};
      q.choices.forEach((choice: any, choiceIndex: number) => {
        if (!choice || typeof choice !== "object" || Array.isArray(choice)) fail(`Choice ${label} has an invalid option`);
        if (typeof choice.value !== "string" && typeof choice.value !== "boolean") {
          fail(`Choice values for ${label} must be strings or booleans`);
        }
        if (choice.description !== undefined && typeof choice.description !== "string") {
          fail(`Choice descriptions for ${label} must be strings`);
        }
        const key = `${typeof choice.value}:${String(choice.value)}`;
        if (seen.has(key)) fail(`Choice values for ${label} must be unique`);
        seen.add(key);
        const option = `o${choiceIndex}`;
        maps[id].choices[option] = choice.value;
        criteria[option] = choice.description || String(choice.value);
      });
      questions[id] = { type: "choice", instructions, criteria };
      return;
    }

    if (!Array.isArray(q.levels) || q.levels.length < 2 || q.levels.length > 10) {
      fail(`Score ${label} must have 2–10 levels`);
    }
    q.levels.forEach((level: any) => {
      if (!level || typeof level !== "object" || Array.isArray(level) || typeof level.label !== "string" || !level.label.trim()) {
        fail(`Score ${label} requires a label for every level`);
      }
      if (level.description !== undefined && typeof level.description !== "string") {
        fail(`Score level descriptions for ${label} must be strings`);
      }
    });
    maps[id].levels = q.levels;
    questions[id] = {
      type: "score",
      instructions,
      criteria: q.levels.map((level: ScoreLevel) => `${level.label}${level.description ? `: ${level.description}` : ""}`),
    };
  });

  return {
    wire: { model: requestedModel.replace(/^jev\//, ""), state: input.input, questions },
    maps,
    model: requestedModel.startsWith("jev/") ? requestedModel : `jev/${requestedModel}`,
  };
}

export function systemOneToDecision(result: any, maps: Record<string, any>, requestedModel: string) {
  const probabilitySet = (probabilities: Record<string, number>) => {
    const pairs = Object.entries(probabilities).map(([key, value]) => [key, Number(value)] as const);
    if (!pairs.length || pairs.some(([, value]) => !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error("Jev returned an invalid probability distribution");
    }
    if (Math.abs(pairs.reduce((total, [, value]) => total + value, 0) - 1) > 0.02) {
      throw new Error("Jev returned an invalid probability distribution");
    }
    return pairs;
  };

  const confidenceValue = (value: unknown) => {
    const confidence = Number(value);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("Jev returned invalid confidence");
    return confidence;
  };

  const answers = Object.entries(maps).map(([id, map]: [string, any]) => {
    const answer = result?.answers?.[id];
    if (!answer || typeof answer !== "object") throw new Error("Jev returned an incomplete or mismatched answer");
    if (answer.type === "refusal") return { type: "refusal", name: map.name };
    if (answer.type !== map.nativeType) throw new Error("Jev returned an incomplete or mismatched answer");

    if (map.type === "predicate") {
      const probability = Number(answer.noul);
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("Jev returned an invalid predicate probability");
      return { type: "predicate", name: map.name, probability };
    }

    const confidence = confidenceValue(answer.confidence);

    if (map.type === "choice") {
      const choice = map.choices?.[answer.choice];
      if (choice === undefined) throw new Error("Jev selected an unknown choice");
      const probabilities = probabilitySet(answer.probabilities || {});
      return {
        type: "choice",
        name: map.name,
        choice,
        probabilities: probabilities.map(([key, probability]) => {
          if (map.choices?.[key] === undefined) throw new Error("Jev returned an unknown choice in the probability distribution");
          return { value: map.choices[key], probability };
        }),
        confidence,
      };
    }

    const score = Number(answer.score);
    if (!Number.isFinite(score) || score < 0 || score > map.levels.length - 1) throw new Error("Jev returned an invalid fractional score");
    const probabilities = probabilitySet(answer.probabilities || {});
    return {
      type: "score",
      name: map.name,
      score,
      probabilities: probabilities.map(([key, probability]) => {
        const level = Number(key);
        if (!Number.isInteger(level) || level < 0 || level >= map.levels.length) throw new Error("Jev returned an invalid score level");
        return { value: level, label: map.levels[level].label, probability };
      }),
      confidence,
    };
  });

  const tokenCount = (value: unknown, field: string) => {
    const count = Number(value ?? 0);
    if (!Number.isFinite(count) || count < 0) throw new Error(`Jev returned invalid ${field}`);
    return Math.round(count);
  };

  const usageSource = result?.usage ?? {};
  const inputTokens = tokenCount(usageSource.input_tokens, "input token usage");
  const outputTokens = tokenCount(usageSource.output_tokens, "output token usage");
  const usage = {
    input_tokens: inputTokens,
    input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  };

  return {
    model: `jev/${result?.model || requestedModel.replace(/^jev\//, "")}`,
    answers,
    usage,
  };
}

export function mapUpstreamError(status: number, payload: any) {
  const detail = payload?.detail;
  const message =
    typeof detail === "string"
      ? detail
      : Array.isArray(detail)
        ? detail
            .map((item: any) => (typeof item === "string" ? item : typeof item?.msg === "string" ? item.msg : ""))
            .filter(Boolean)
            .join("; ")
        : "";

  if (status === 429) {
    return {
      status: 429,
      body: {
        error: {
          message: message || "Jev rate limit exceeded",
          type: "rate_limit_error",
          param: null,
          code: "rate_limit_exceeded",
        },
      },
    };
  }
  if (status === 400 || status === 422) {
    return {
      status: 400,
      body: {
        error: {
          message: message || "Jev rejected the request",
          type: "invalid_request_error",
          param: null,
          code: "invalid_request",
        },
      },
    };
  }
  if (status === 401 || status === 403) {
    return {
      status: 502,
      body: {
        error: {
          message: "Jev rejected the gateway credentials",
          type: "server_error",
          param: null,
          code: "jev_auth_error",
        },
      },
    };
  }
  return {
    status: 502,
    body: {
      error: {
        message: message || "Jev is unavailable",
        type: "server_error",
        param: null,
        code: "jev_unavailable",
      },
    },
  };
}

export async function callSystemOne(body: unknown, headers?: HeadersInit, timeoutMs = 90000) {
  if (!env.jevKey) throw new Error("JEV_TYPESAFE_API_KEY is not configured");
  return fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${env.jevKey}`, "content-type": "application/json", ...(headers || {}) },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
}
