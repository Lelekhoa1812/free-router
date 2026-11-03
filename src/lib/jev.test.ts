import { describe, expect, it } from "vitest";
import { decisionToSystemOne, mapUpstreamError, systemOneToDecision } from "@/lib/jev";

const predicate = { type: "predicate", instructions: "Is this urgent?" };

describe("OpenAI Decisions ↔ TypeSafe System One adapter", () => {
  it("uses opaque native IDs and restores typed choice values and ordered score levels", () => {
    const { wire, maps } = decisionToSystemOne({
      model: "jev/jev-latest",
      input: "Ticket evidence",
      questions: [
        { type: "predicate", name: "urgent", instructions: "Is this urgent?" },
        {
          type: "choice",
          name: "route",
          instructions: "Choose a route",
          choices: [
            { value: true, description: "Engineering" },
            { value: "billing", description: "Billing" },
          ],
        },
        { type: "score", name: "severity", instructions: "Rate severity", levels: [{ label: "Low" }, { label: "High" }] },
      ],
    });
    expect(wire).toEqual({
      model: "jev-latest",
      state: "Ticket evidence",
      questions: {
        q0: { type: "noul", instructions: "Is this urgent?" },
        q1: { type: "choice", instructions: "Choose a route", criteria: { o0: "Engineering", o1: "Billing" } },
        q2: { type: "score", instructions: "Rate severity", criteria: ["Low", "High"] },
      },
    });
    const result = systemOneToDecision(
      {
        model: "jev-1.14.0",
        answers: {
          q0: { type: "noul", noul: 0.91 },
          q1: { type: "choice", choice: "o0", confidence: 0.8, probabilities: { o0: 0.8, o1: 0.2 } },
          q2: { type: "score", score: 0.6, confidence: 0.7, probabilities: { 0: 0.4, 1: 0.6 } },
        },
        usage: { input_tokens: 8, output_tokens: 3 },
      },
      maps,
      "jev/jev-latest",
    );
    expect(result.model).toBe("jev/jev-1.14.0");
    expect(result.answers[1]).toMatchObject({ type: "choice", name: "route", choice: true });
    expect(result.answers[2]).toMatchObject({
      score: 0.6,
      probabilities: [
        { value: 0, label: "Low", probability: 0.4 },
        { value: 1, label: "High", probability: 0.6 },
      ],
    });
  });

  it("accepts unnamed and duplicate question names and returns null names", () => {
    const { maps, model } = decisionToSystemOne({
      model: "jev/jev-latest",
      input: "x",
      questions: [predicate, predicate],
    });
    const result = systemOneToDecision(
      { model: "jev-1.14.0", answers: { q0: { type: "noul", noul: 0.4 }, q1: { type: "noul", noul: 0.6 } } },
      maps,
      model,
    );
    expect(result.answers).toEqual([
      { type: "predicate", name: null, probability: 0.4 },
      { type: "predicate", name: null, probability: 0.6 },
    ]);
  });

  it("accepts OpenAI cache and safety fields without forwarding them", () => {
    const { wire } = decisionToSystemOne({
      model: "jev/jev-latest",
      input: "x",
      prompt_cache_key: "k".repeat(64),
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
      safety_identifier: "user-1",
      questions: [predicate],
    });
    expect(wire).toEqual({ model: "jev-latest", state: "x", questions: { q0: { type: "noul", instructions: "Is this urgent?" } } });
  });

  it("rejects malformed cache fields and unknown request fields", () => {
    const request = (extra: Record<string, unknown>) => ({ model: "jev/jev-latest", input: "x", questions: [predicate], ...extra });
    expect(() => decisionToSystemOne(request({ prompt_cache_key: "k".repeat(65) }))).toThrow(/64/);
    expect(() => decisionToSystemOne(request({ prompt_cache_options: { mode: "fast" } }))).toThrow(/mode/);
    expect(() => decisionToSystemOne(request({ prompt_cache_options: { ttl: "1h" } }))).toThrow(/ttl/);
    expect(() => decisionToSystemOne(request({ safety_identifier: "x".repeat(129) }))).toThrow(/128/);
    expect(() => decisionToSystemOne(request({ unsupported: true }))).toThrow(/Unsupported Decisions field/);
  });

  it("accepts content-part instructions and refuses image evidence", () => {
    const parts = [{ type: "input_text", text: "Is this urgent?" }, { type: "input_json", data: { severity: 3 } }];
    const { wire } = decisionToSystemOne({
      model: "jev/jev-latest",
      input: "x",
      questions: [{ type: "predicate", name: "urgent", instructions: parts }],
    });
    expect(wire.questions.q0.instructions).toEqual(parts);
    expect(() =>
      decisionToSystemOne({
        model: "jev/jev-latest",
        input: "x",
        questions: [{ type: "predicate", instructions: [{ type: "input_image", image_url: "https://example.test/a.png" }] }],
      }),
    ).toThrow(/Image decision evidence/);
  });

  it("requires labels for score levels and unique typed choice values", () => {
    expect(() =>
      decisionToSystemOne({
        model: "jev/jev-latest",
        input: "x",
        questions: [{ type: "score", instructions: "Score", levels: [{ description: "no label" }, { label: "High" }] }],
      }),
    ).toThrow(/label/);
    expect(() =>
      decisionToSystemOne({
        model: "jev/jev-latest",
        input: "x",
        questions: [{ type: "choice", instructions: "Pick", choices: [{ value: "a" }, { value: "a" }] }],
      }),
    ).toThrow(/unique/);
    expect(() =>
      decisionToSystemOne({
        model: "jev/jev-latest",
        input: "x",
        questions: [{ type: "choice", instructions: "Pick", choices: [{ value: "true" }, { value: true }] }],
      }),
    ).not.toThrow();
  });

  it("returns complete usage and no fields outside OpenAI's Decision schema", () => {
    const { maps, model } = decisionToSystemOne({ model: "jev/jev-latest", input: "x", questions: [predicate] });
    const result = systemOneToDecision(
      { model: "jev-1.14.0", answers: { q0: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 8, output_tokens: 3 } },
      maps,
      model,
    );
    expect(result.usage).toEqual({
      input_tokens: 8,
      input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 11,
    });
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("object");
    const withoutUsage = systemOneToDecision({ model: "jev-1.14.0", answers: { q0: { type: "noul", noul: 0.5 } } }, maps, model);
    expect(withoutUsage.usage).toEqual({
      input_tokens: 0,
      input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    });
  });

  it("returns a refusal answer instead of failing the whole request", () => {
    const { maps, model } = decisionToSystemOne({
      model: "jev/jev-latest",
      input: "x",
      questions: [{ type: "predicate", name: "urgent", instructions: "Is this urgent?" }],
    });
    const result = systemOneToDecision({ model: "jev-1.14.0", answers: { q0: { type: "refusal" } } }, maps, model);
    expect(result.answers[0]).toEqual({ type: "refusal", name: "urgent" });
  });

  it("rejects malformed question sets, non-Jev models and non-string input", () => {
    expect(() => decisionToSystemOne({ model: "gpt-6-luna", input: "x", questions: [predicate] })).toThrow(/Jev model/);
    expect(() => decisionToSystemOne({ model: "jev/jev-latest", input: {}, questions: [predicate] })).toThrow(/input/);
    expect(() =>
      decisionToSystemOne({
        model: "jev/jev-latest",
        input: "x",
        questions: [{ type: "score", name: "s", instructions: "score", levels: [{ label: "only one" }] }],
      }),
    ).toThrow(/2–10/);
    expect(() =>
      decisionToSystemOne({
        model: "jev/jev-latest",
        input: "x",
        questions: [{ type: "predicate", name: 4, instructions: "yes" }],
      }),
    ).toThrow(/name/);
  });

  it("normalizes TypeSafe failures into the OpenAI error envelope", () => {
    expect(mapUpstreamError(422, { detail: [{ loc: ["body", "state"], msg: "Field required", type: "missing" }] })).toEqual({
      status: 400,
      body: { error: { message: "Field required", type: "invalid_request_error", param: null, code: "invalid_request" } },
    });
    expect(mapUpstreamError(429, { detail: "slow down" })).toEqual({
      status: 429,
      body: { error: { message: "slow down", type: "rate_limit_error", param: null, code: "rate_limit_exceeded" } },
    });
    expect(mapUpstreamError(401, { detail: "bad key" })).toMatchObject({
      status: 502,
      body: { error: { code: "jev_auth_error" } },
    });
    expect(mapUpstreamError(500, null)).toEqual({
      status: 502,
      body: { error: { message: "Jev is unavailable", type: "server_error", param: null, code: "jev_unavailable" } },
    });
  });
});
