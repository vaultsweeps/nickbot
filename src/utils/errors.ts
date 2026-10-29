/** Thrown for failures worth retrying (network, 429, 5xx, lock contention, DB hiccups). */
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Telegram ${method} failed (${code}): ${description}`);
    this.name = 'TelegramApiError';
  }

  /** 429, 5xx and transport failures (code 0) are transient. 4xx otherwise is permanent. */
  get retryable(): boolean {
    return this.code === 0 || this.code === 429 || this.code >= 500;
  }

  get topicMissing(): boolean {
    return (
      this.code === 400 &&
      /message thread not found|TOPIC_DELETED|topic.*(deleted|not found)/i.test(this.description)
    );
  }

  get botBlockedOrChatGone(): boolean {
    return (
      this.code === 403 || (this.code === 400 && /chat not found|user is deactivated/i.test(this.description))
    );
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof RetryableError || (err instanceof TelegramApiError && err.retryable);
}
