const DEFAULT_TIMEOUT_MS = 25_000;

function cancellationError() {
  return new DOMException("Request cancelled", "AbortError");
}

/**
 * Abort the underlying request and reject independently when the deadline is
 * reached. The explicit race is required because some worker runtimes do not
 * settle an upstream fetch promise promptly after AbortController.abort().
 */
export async function fetchWithTimeout(input, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const parentSignal = init.signal;
  if (parentSignal?.aborted) throw parentSignal.reason ?? cancellationError();
  const controller = new AbortController();
  const cancel = () => controller.abort(parentSignal?.reason ?? cancellationError());
  parentSignal?.addEventListener("abort", cancel, { once: true });

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Request timed out after ${Math.round(timeoutMs / 1_000)} seconds`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", cancel);
  }
}
