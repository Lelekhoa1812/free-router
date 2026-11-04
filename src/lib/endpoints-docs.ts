export type EndpointDoc = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  title: string;
  description: string;
  auth: "client" | "admin";
  scope?: "chat" | "responses" | "decisions" | "embeddings" | "chat/responses";
};

export const ENDPOINT_DOCS = {
  llm: [
    { method: "GET", path: "/v1/models", title: "List allowed models", description: "Lists chat models and, when this key has the embeddings scope, explicit vector models too.", auth: "client", scope: "chat/responses" },
    { method: "GET", path: "/v1/models/{model}", title: "Retrieve a model", description: "Returns one model record using its family scope. URL-encode provider-qualified IDs that contain slashes.", auth: "client", scope: "chat/responses" },
    { method: "POST", path: "/v1/chat/completions", title: "Chat Completions", description: "OpenAI-compatible chat. FreeRouter requests upstream streaming and can forward SSE or assemble a JSON response.", auth: "client", scope: "chat" },
    { method: "POST", path: "/v1/responses", title: "Responses", description: "OpenAI Responses input and output items, streaming events, and optional 24-hour previous_response_id state.", auth: "client", scope: "responses" },
    { method: "GET", path: "/v1/responses/{id}", title: "Retrieve response", description: "Retrieves a stored response owned by this API key.", auth: "client", scope: "responses" },
    { method: "GET", path: "/v1/responses/{id}/input_items", title: "List input items", description: "Lists stored input items with cursor pagination.", auth: "client", scope: "responses" },
    { method: "DELETE", path: "/v1/responses/{id}", title: "Delete response", description: "Deletes this key’s stored response resource.", auth: "client", scope: "responses" },
  ] satisfies EndpointDoc[],
  decisions: [
    { method: "GET", path: "/v1/models?type=decision", title: "Discover decision models", description: "Lists Jev decision models available to the configured TypeSafe account.", auth: "client", scope: "decisions" },
    { method: "GET", path: "/v1/systemone/models", title: "Native Jev models", description: "Returns TypeSafe’s native model discovery response.", auth: "client", scope: "decisions" },
    { method: "POST", path: "/v1/decisions", title: "OpenAI Decisions adapter", description: "Maps OpenAI decision questions and evidence to Jev System One, preserving typed answers and fractional scores.", auth: "client", scope: "decisions" },
    { method: "POST", path: "/v1/systemone", title: "Native System One", description: "Passes the native TypeSafe state and named questions contract through FreeRouter.", auth: "client", scope: "decisions" },
  ] satisfies EndpointDoc[],
  embeddings: [
    { method: "GET", path: "/v1/models?type=embedding", title: "Discover embedding models", description: "Lists credential-available, certified embedding model IDs permitted for this key.", auth: "client", scope: "embeddings" },
    { method: "POST", path: "/v1/embeddings", title: "Create embeddings", description: "OpenAI-compatible vector embeddings for a specifically named, certified embedding model.", auth: "client", scope: "embeddings" },
  ] satisfies EndpointDoc[],
} as const;

export const DOCUMENTED_EMBEDDING_POLICY = {
  autoRouted: false,
  modelRequired: true,
  discoveryPath: "/v1/models?type=embedding",
  endpointPath: "/v1/embeddings",
} as const;
