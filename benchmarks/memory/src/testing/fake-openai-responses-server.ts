import http from "node:http";

export interface FakeOpenAIRequest {
  authorization: string | null;
  organization: string | null;
  body: Record<string, unknown>;
}

export interface FakeOpenAIResponsesServerOptions {
  apiKey: string;
  failFirstRequests?: number;
}

function responseBody(text: string): Record<string, unknown> {
  return {
    id: "resp_memory_bench_contract",
    object: "response",
    status: "completed",
    error: null,
    output: [
      {
        type: "message",
        id: "msg_memory_bench_contract",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text,
            annotations: [],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 3,
      total_tokens: 103,
    },
  };
}

async function requestJson(
  request: http.IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 2 * 1024 * 1024) {
      throw new Error("fake OpenAI request body is too large");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("fake OpenAI request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(encoded),
    "openai-processing-ms": "7",
    ...headers,
  });
  response.end(encoded);
}

export class FakeOpenAIResponsesServer {
  readonly requests: FakeOpenAIRequest[] = [];

  private readonly server: http.Server;
  private remainingFailures: number;
  private originValue: string | null = null;

  constructor(private readonly options: FakeOpenAIResponsesServerOptions) {
    this.remainingFailures = options.failFirstRequests ?? 0;
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  get baseUrl(): string {
    if (this.originValue === null) {
      throw new Error("fake OpenAI server has not started");
    }
    return `${this.originValue}/v1`;
  }

  async start(): Promise<void> {
    if (this.originValue !== null) {
      throw new Error("fake OpenAI server is already running");
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("fake OpenAI server has no TCP address");
    }
    this.originValue = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    this.originValue = null;
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    try {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        sendJson(response, 404, { error: { message: "not found" } });
        return;
      }
      const authorization = request.headers.authorization ?? null;
      if (authorization !== `Bearer ${this.options.apiKey}`) {
        sendJson(response, 401, {
          error: { message: "invalid contract credential" },
        });
        return;
      }
      const body = await requestJson(request);
      this.requests.push({
        authorization,
        organization:
          typeof request.headers["openai-organization"] === "string"
            ? request.headers["openai-organization"]
            : null,
        body,
      });
      if (this.remainingFailures > 0) {
        this.remainingFailures -= 1;
        sendJson(
          response,
          429,
          { error: { message: "contract rate limit" } },
          { "Retry-After": "0" }
        );
        return;
      }
      const input = typeof body.input === "string" ? body.input : "";
      const isJudge = input.includes("Answer yes or no only.");
      const output = isJudge
        ? input.includes("FORCE_NO")
          ? "No"
          : "Yes"
        : input.toLocaleLowerCase("en-US").includes("green")
          ? "green"
          : "There is not enough information.";
      sendJson(response, 200, responseBody(output));
    } catch (error) {
      sendJson(response, 400, {
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}
