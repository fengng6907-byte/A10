export class ProviderError extends Error {
  constructor(message: string, public retryable = true, public code?: string) { super(message); }
}
