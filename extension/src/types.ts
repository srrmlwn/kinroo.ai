export interface EventCandidate {
  title: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
  timezone?: string;
  location?: string;
}

export interface ParseResponse {
  intent: "create" | "query" | "unknown";
  candidates: EventCandidate[];
  answer?: string;
  usedLLM: boolean;
  inputType: "text" | "image" | "pdf";
}

export interface CreateEventsResponse {
  events: Array<
    | { ok: true; event: { id: string; title: string; start: string; end: string } }
    | { ok: false; candidate: EventCandidate; error: string }
  >;
}
