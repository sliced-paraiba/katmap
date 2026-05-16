export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter: number | null,
  ) {
    super(message);
  }
}

type ParseMode = "auto" | "json" | "text" | "none";

interface ApiOptions {
  token?: string;
  parse?: ParseMode;
}

export function bindTokenInput(input: HTMLInputElement, storageKey: string) {
  input.value = localStorage.getItem(storageKey) || "";
  input.addEventListener("input", () => localStorage.setItem(storageKey, input.value));
}

export function authHeaders(token: string, json = true): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

export function createTokenApi(input: HTMLInputElement, options: Omit<ApiOptions, "token"> = {}) {
  return <T>(url: string, opts: RequestInit = {}, callOptions: Omit<ApiOptions, "token"> = {}) =>
    api<T>(url, opts, {
      ...options,
      ...callOptions,
      token: input.value,
    });
}

export async function api<T>(
  url: string,
  opts: RequestInit = {},
  options: ApiOptions = {},
): Promise<T> {
  const headers = new Headers(opts.headers);
  const token = options.token ?? "";
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && opts.body != null) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    const retryAfter = Number.parseInt(res.headers.get("retry-after") || "", 10);
    throw new ApiError(
      await res.text() || res.statusText,
      res.status,
      Number.isFinite(retryAfter) ? retryAfter : null,
    );
  }

  const parse = options.parse ?? "auto";
  if (parse === "none") return undefined as T;
  if (parse === "text") return await res.text() as T;
  if (parse === "json") return await res.json() as T;

  const contentType = res.headers.get("content-type") || "";
  return (contentType.includes("json") ? await res.json() : await res.text()) as T;
}
