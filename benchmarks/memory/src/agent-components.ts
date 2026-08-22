import type {
  AgentCleanupResult,
  AgentComponentInfo,
  AgentComponentTelemetry,
  AgentContextItem,
  AgentIngestSession,
  AgentJudgeDecision,
  AgentJudgeInput,
  AgentMemoryAdapter,
  AgentMemoryQuery,
  AgentMemoryReader,
  AgentMemoryJudge,
  AgentReaderInput,
  AgentRunContext,
  AgentScenarioContext,
} from "./agent-types.js";

const stopwords = new Set([
  "a",
  "an",
  "and",
  "did",
  "does",
  "for",
  "in",
  "is",
  "it",
  "of",
  "on",
  "the",
  "to",
  "use",
  "what",
  "where",
  "which",
]);

function tokens(value: string): Set<string> {
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US");
  return new Set(
    (normalized.match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (token) => token.length > 1 && !stopwords.has(token)
    )
  );
}

function overlapScore(query: Set<string>, content: Set<string>): number {
  let overlap = 0;
  for (const token of query) if (content.has(token)) overlap += 1;
  if (overlap === 0) return 0;
  return overlap / Math.sqrt(query.size * content.size);
}

function emptyTelemetry(): AgentComponentTelemetry {
  return {
    requestCount: 0,
    retryCount: 0,
    requestBytes: 0,
    responseBytes: 0,
    inputTokens: 0,
    outputTokens: 0,
    providerProcessingMs: null,
    providerCostUsd: 0,
    costSource: "not-applicable",
  };
}

export class LiteralAgentMemoryAdapter implements AgentMemoryAdapter {
  readonly info: AgentComponentInfo = {
    name: "literal",
    version: "1",
    mode: "per-scenario-token-overlap",
    classification: "harness",
    config: {
      threshold: "score>0",
      scenarioIsolation: true,
    },
  };

  private setupComplete = false;
  private activeScenario: string | null = null;
  private readonly sessions = new Map<string, AgentIngestSession>();

  async setup(_context: AgentRunContext): Promise<void> {
    if (this.setupComplete) {
      throw new Error("literal agent adapter is already set up");
    }
    this.setupComplete = true;
    this.activeScenario = null;
    this.sessions.clear();
  }

  async beginScenario(context: AgentScenarioContext): Promise<void> {
    if (!this.setupComplete) {
      throw new Error("literal agent adapter has not been set up");
    }
    if (this.activeScenario !== null || this.sessions.size > 0) {
      throw new Error("literal agent adapter contains uncleared scenario state");
    }
    this.activeScenario = context.scenarioId;
  }

  async ingest(session: AgentIngestSession): Promise<void> {
    if (this.activeScenario === null) {
      throw new Error("literal agent adapter has no active scenario");
    }
    if (this.sessions.has(session.id)) {
      throw new Error(`literal agent adapter duplicate session: ${session.id}`);
    }
    this.sessions.set(session.id, structuredClone(session));
  }

  async query(input: AgentMemoryQuery): Promise<AgentContextItem[]> {
    if (this.activeScenario === null) {
      throw new Error("literal agent adapter has no active scenario");
    }
    const queryTokens = tokens(input.question);
    return [...this.sessions.values()]
      .map((session) => {
        const value = session.messages
          .map((message) => `${message.role}: ${message.content}`)
          .join("\n");
        return {
          session,
          value,
          score: overlapScore(queryTokens, tokens(value)),
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.session.id.localeCompare(right.session.id)
      )
      .slice(0, input.topK)
      .map(({ session, value, score }) => ({
        type: "text" as const,
        value: JSON.stringify(session.messages),
        observedAt: session.date,
        sourceSessionId: session.id,
        score,
      }));
  }

  async endScenario(): Promise<AgentCleanupResult> {
    this.activeScenario = null;
    this.sessions.clear();
    return {
      attempted: true,
      succeeded: true,
      verified: this.activeScenario === null && this.sessions.size === 0,
    };
  }

  async teardown(): Promise<void> {
    this.activeScenario = null;
    this.sessions.clear();
    this.setupComplete = false;
  }

  getTelemetry(): AgentComponentTelemetry {
    return emptyTelemetry();
  }
}

const colorNames = [
  "black",
  "blue",
  "brown",
  "green",
  "orange",
  "pink",
  "purple",
  "red",
  "white",
  "yellow",
] as const;

export class FixtureEvidenceReader implements AgentMemoryReader {
  readonly info: AgentComponentInfo = {
    name: "fixture-evidence-reader",
    version: "1",
    mode: "deterministic-contract-fixture",
    classification: "harness",
    config: {
      supportedIntent: "which-color",
      emptyContextAbstains: true,
    },
  };

  async answer(input: AgentReaderInput): Promise<string> {
    const text = input.context
      .filter((item) => item.type === "text")
      .map((item) => item.value)
      .join("\n")
      .toLocaleLowerCase("en-US");
    if (text === "") {
      return "There is not enough information to answer.";
    }
    if (input.question.toLocaleLowerCase("en-US").includes("color")) {
      const color = colorNames.find((candidate) =>
        new RegExp(`\\b${candidate}\\b`, "u").test(text)
      );
      if (color !== undefined) return color;
    }
    return "The deterministic fixture reader cannot answer this question.";
  }

  getTelemetry(): AgentComponentTelemetry {
    return emptyTelemetry();
  }
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const abstentionSignals = [
  "cannot answer",
  "cannot determine",
  "insufficient information",
  "not enough information",
] as const;

export class FixtureJudge implements AgentMemoryJudge {
  readonly info: AgentComponentInfo = {
    name: "fixture-judge",
    version: "1",
    mode: "deterministic-exact-or-abstention",
    classification: "harness",
    config: {
      purpose: "runner-contract-tests-only",
    },
  };

  async evaluate(input: AgentJudgeInput): Promise<AgentJudgeDecision> {
    const normalizedHypothesis = normalize(input.hypothesis);
    const passed = input.expectedAbstention
      ? abstentionSignals.some((signal) =>
          normalizedHypothesis.includes(signal)
        )
      : normalizedHypothesis.includes(normalize(input.expectedAnswer));
    return {
      passed,
      score: passed ? 1 : 0,
      label: passed ? "yes" : "no",
    };
  }

  getTelemetry(): AgentComponentTelemetry {
    return emptyTelemetry();
  }
}
