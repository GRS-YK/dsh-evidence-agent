/**
 * OpenAI-compatible embedding client with timeout and bounded retries.
 * @module dsh-evidence-agent/lib/embedding-client
 */

/**
 * Error raised for invalid embedding requests or responses.
 */
export class EmbeddingError extends Error {
  /**
   * @param {string} message - user-facing error message.
   * @param {object} [details] - optional error details.
   * @param {number} [details.status] - HTTP status code.
   * @param {boolean} [details.retryable=false] - whether a retry may succeed.
   * @param {unknown} [details.cause] - original error.
   */
  constructor(message, { status, retryable = false, cause } = {}) {
    super(message, { cause })
    this.name = 'EmbeddingError'
    this.status = status
    this.retryable = retryable
  }
}

/**
 * Create an OpenAI-compatible text embedding client.
 * @param {object} options - client options.
 * @param {string} options.baseUrl - API base URL, without `/embeddings`.
 * @param {string} options.apiKey - API key.
 * @param {string} options.model - embedding model ID.
 * @param {number} options.dimension - required vector dimension.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation for tests.
 * @param {number} [options.timeoutMs=30000] - per-request timeout.
 * @param {number} [options.maxRetries=2] - retry count for transient failures.
 * @param {number} [options.retryDelayMs=500] - initial exponential backoff delay.
 * @param {(milliseconds: number) => Promise<void>} [options.sleep] - delay function.
 * @returns {{model: string, dimension: number, endpoint: string, embed: Function}} client.
 */
export function createOpenAICompatibleEmbeddingClient({
  baseUrl,
  apiKey,
  model,
  dimension,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  maxRetries = 2,
  retryDelayMs = 500,
  sleep = delay,
}) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new TypeError('baseUrl must be a non-empty string')
  }
  if (baseUrl.trim().replace(/\/+$/, '').endsWith('/embeddings')) {
    throw new TypeError('baseUrl must not include /embeddings')
  }
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new TypeError('apiKey must be a non-empty string')
  }
  if (typeof model !== 'string' || model.trim() === '') {
    throw new TypeError('model must be a non-empty string')
  }
  if (!Number.isInteger(dimension) || dimension < 1) {
    throw new RangeError('dimension must be a positive integer')
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('timeoutMs must be a positive integer')
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError('maxRetries must be a non-negative integer')
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new RangeError('retryDelayMs must be a non-negative integer')
  }

  const endpoint = baseUrl.trim().replace(/\/+$/, '') + '/embeddings'

  return {
    model,
    dimension,
    endpoint,

    /**
     * Embed a non-empty batch of text inputs.
     * @param {string[]} texts - inputs in source order.
     * @returns {Promise<number[][]>} vectors in the same order as inputs.
     */
    async embed(texts) {
      if (
        !Array.isArray(texts)
        || texts.length === 0
        || texts.some(text => typeof text !== 'string' || text.length === 0)
      ) {
        throw new TypeError('texts must be a non-empty array of non-empty strings')
      }

      let lastError
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await requestEmbeddings({
            endpoint,
            apiKey,
            model,
            dimension,
            texts,
            fetchImpl,
            timeoutMs,
          })
        } catch (error) {
          const normalized = error instanceof EmbeddingError
            ? error
            : new EmbeddingError('Embedding request failed', {
              retryable: true,
              cause: error,
            })
          lastError = normalized
          if (!normalized.retryable || attempt === maxRetries) throw normalized
          await sleep(retryDelayMs * (2 ** attempt))
        }
      }

      throw lastError
    },
  }
}

/**
 * Execute one embedding HTTP request and validate its response.
 * @param {object} options - request options.
 * @returns {Promise<number[][]>} validated vectors.
 */
async function requestEmbeddings({
  endpoint,
  apiKey,
  model,
  dimension,
  texts,
  fetchImpl,
  timeoutMs,
}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: texts,
        }),
        signal: controller.signal,
      })
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new EmbeddingError(`Embedding request timed out after ${timeoutMs} ms`, {
          retryable: true,
          cause: error,
        })
      }
      throw new EmbeddingError('Could not connect to the embedding service', {
        retryable: true,
        cause: error,
      })
    }

    if (!response.ok) {
      const responseText = await readResponseText(response)
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500
      throw new EmbeddingError(
        `Embedding service returned HTTP ${response.status}${responseText ? `: ${responseText}` : ''}`,
        { status: response.status, retryable },
      )
    }

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      throw new EmbeddingError('Embedding service returned invalid JSON', {
        status: response.status,
        retryable: true,
        cause: error,
      })
    }

    return validateEmbeddingResponse(payload, texts.length, dimension)
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Validate OpenAI-compatible embedding payload and preserve input order.
 * @param {unknown} payload - parsed response.
 * @param {number} expectedCount - number of inputs.
 * @param {number} dimension - expected vector dimension.
 * @returns {number[][]} ordered vectors.
 */
export function validateEmbeddingResponse(payload, expectedCount, dimension) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
    throw new EmbeddingError('Embedding response is missing data[]', { retryable: true })
  }
  if (payload.data.length !== expectedCount) {
    throw new EmbeddingError(
      `Embedding response count mismatch: expected ${expectedCount}, got ${payload.data.length}`,
      { retryable: true },
    )
  }

  const indexed = payload.data.map((item, position) => {
    const index = item?.index ?? position
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount) {
      throw new EmbeddingError(`Invalid embedding index at response position ${position}`)
    }
    if (!Array.isArray(item.embedding)) {
      throw new EmbeddingError(`Embedding at index ${index} is not an array`)
    }
    if (item.embedding.length !== dimension) {
      throw new EmbeddingError(
        `Embedding dimension mismatch at index ${index}: expected ${dimension}, got ${item.embedding.length}`,
      )
    }
    item.embedding.forEach((value, valueIndex) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new EmbeddingError(
          `Embedding at index ${index} contains an invalid value at position ${valueIndex}`,
        )
      }
    })
    return { index, embedding: item.embedding }
  }).sort((left, right) => left.index - right.index)

  const actualIndexes = indexed.map(item => item.index)
  if (new Set(actualIndexes).size !== expectedCount) {
    throw new EmbeddingError('Embedding response contains duplicate indexes')
  }

  return indexed.map(item => item.embedding)
}

/**
 * Read a short response body without letting diagnostics mask the original error.
 * @param {Response} response - failed HTTP response.
 * @returns {Promise<string>} truncated response text.
 */
async function readResponseText(response) {
  try {
    return (await response.text()).slice(0, 500)
  } catch {
    return ''
  }
}

/**
 * Wait for a number of milliseconds.
 * @param {number} milliseconds - delay duration.
 * @returns {Promise<void>} resolves after the delay.
 */
function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
