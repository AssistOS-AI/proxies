export class SearchGatewayError extends Error {
  constructor(message, status = 500, type = 'internal_error') {
    super(message);
    this.status = status;
    this.type = type;
  }
}

export class AuthError extends SearchGatewayError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'authentication_error');
  }
}

export class RateLimitError extends SearchGatewayError {
  constructor(message = 'Rate limit exceeded', retryAfter = 60) {
    super(message, 429, 'rate_limit_error');
    this.retryAfter = retryAfter;
  }
}

export class ModelNotFoundError extends SearchGatewayError {
  constructor(model) {
    super(`Model '${model}' not found or disabled`, 404, 'model_not_found');
  }
}

export class ProviderError extends SearchGatewayError {
  constructor(provider, message, status = 502) {
    super(`${provider}: ${message}`, status, 'provider_error');
    this.provider = provider;
  }
}

export class QuotaExceededError extends SearchGatewayError {
  constructor(provider, used, quota) {
    super(`Monthly quota exceeded for ${provider}: ${used}/${quota}`, 429, 'quota_exceeded');
    this.provider = provider;
    this.retryAfter = 3600;
  }
}
