export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** Overrides the provider default when set. */
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  readonly weight: number;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/** Thrown by providers so the pool can decide whether to fail over. */
export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    message: string,
    readonly provider: string,
    /** Whether trying a different provider might succeed. */
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}
