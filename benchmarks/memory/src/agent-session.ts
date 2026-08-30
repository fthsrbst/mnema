import type {
  AgentIngestMessage,
  AgentIngestSession,
} from "./agent-types.js";

export type AgentSessionSerializer = (
  session: AgentIngestSession
) => string;

export function serializeAgentSessionMessages(
  session: AgentIngestSession
): string {
  return JSON.stringify(session.messages);
}

function splitOversizedMessage(
  session: AgentIngestSession,
  message: AgentIngestMessage,
  maximumCharacters: number,
  serialize: AgentSessionSerializer
): AgentIngestMessage[] {
  const characters = Array.from(message.content);
  const parts: AgentIngestMessage[] = [];
  let offset = 0;
  while (offset < characters.length) {
    let lower = 1;
    let upper = characters.length - offset;
    let accepted = 0;
    while (lower <= upper) {
      const middle = Math.floor((lower + upper) / 2);
      const candidate = {
        role: message.role,
        content: characters.slice(offset, offset + middle).join(""),
      };
      if (
        serialize({
          ...session,
          messages: [candidate],
        }).length <= maximumCharacters
      ) {
        accepted = middle;
        lower = middle + 1;
      } else {
        upper = middle - 1;
      }
    }
    if (accepted === 0) {
      throw new Error(
        `cannot fit a message fragment for session ${session.id}`
      );
    }
    parts.push({
      role: message.role,
      content: characters.slice(offset, offset + accepted).join(""),
    });
    offset += accepted;
  }
  return parts;
}

export function fragmentAgentSession(
  session: AgentIngestSession,
  maximumCharacters: number,
  serialize: AgentSessionSerializer = serializeAgentSessionMessages
): AgentIngestSession[] {
  if (
    !Number.isInteger(maximumCharacters) ||
    maximumCharacters < 1
  ) {
    throw new Error("maximumCharacters must be a positive integer");
  }
  const fragments: AgentIngestSession[] = [];
  let pending: AgentIngestMessage[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    fragments.push({
      ...session,
      messages: pending,
    });
    pending = [];
  };
  for (const message of session.messages) {
    const withMessage = {
      ...session,
      messages: [...pending, message],
    };
    if (serialize(withMessage).length <= maximumCharacters) {
      pending.push(message);
      continue;
    }
    flush();
    const singleMessage = {
      ...session,
      messages: [message],
    };
    if (serialize(singleMessage).length <= maximumCharacters) {
      pending.push(message);
      continue;
    }
    for (const part of splitOversizedMessage(
      session,
      message,
      maximumCharacters,
      serialize
    )) {
      fragments.push({
        ...session,
        messages: [part],
      });
    }
  }
  flush();
  if (fragments.length === 0) {
    throw new Error(`session ${session.id} must contain at least one message`);
  }
  return fragments;
}

export function normalizeAgentProviderTimestamp(value: string): string {
  const longMemEval = value.match(
    /^(\d{4})\/(\d{2})\/(\d{2}) \([A-Za-z]{3}\) (\d{2}):(\d{2})$/u
  );
  if (longMemEval !== null) {
    const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw] =
      longMemEval;
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    const timestamp = new Date(
      Date.UTC(year, month - 1, day, hour, minute)
    );
    if (
      timestamp.getUTCFullYear() !== year ||
      timestamp.getUTCMonth() !== month - 1 ||
      timestamp.getUTCDate() !== day ||
      timestamp.getUTCHours() !== hour ||
      timestamp.getUTCMinutes() !== minute
    ) {
      throw new Error("LongMemEval session date is not a valid wall clock");
    }
    return timestamp.toISOString();
  }
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value
    )
  ) {
    const timestamp = new Date(value);
    if (Number.isFinite(timestamp.getTime())) {
      return timestamp.toISOString();
    }
  }
  throw new Error(
    "agent provider session date must be LongMemEval wall-clock or timezone-qualified ISO 8601"
  );
}
