export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  let text: string;
  try {
    response = await fetch("/api" + path, {
      method,
      headers: method === "GET" ? {} : { "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      signal,
    });
    text = await response.text();
  } catch {
    if (signal?.aborted)
      throw new ApiError("Сервер не ответил вовремя. Повторите запрос.");
    throw new ApiError(
      "Нет соединения с веб-сервисом. Повторите запрос.",
      undefined,
      true,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    /* Proxies can return an empty or HTML error response. */
  }
  if (!response.ok) {
    const retryable = [502, 503, 504].includes(response.status);
    const message =
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof data.error === "string"
        ? data.error
        : retryable
          ? `Веб-сервис временно недоступен (HTTP ${response.status}). Повторите запрос.`
          : `Ошибка запроса (HTTP ${response.status}).`;
    throw new ApiError(message, response.status, retryable);
  }
  if (data === undefined || data === null)
    throw new ApiError(
      "Сервер вернул пустой или некорректный ответ. Сохранение не подтверждено.",
      response.status,
      true,
    );
  return data as T;
}
