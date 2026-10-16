const BASE = `${import.meta.env.VITE_API_URL ?? ''}/api`;
const TOKEN_KEY = 'token';

export const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};
export const setToken = (token) => {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage blocked: the session lasts until reload
  }
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

/** Serialises nested query objects as `filter[field]=value`, arrays as repeated keys. */
export const toQuery = (params = {}) => {
  const search = new URLSearchParams();
  const add = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      for (const v of value) add(key, v);
    } else if (typeof value === 'object' && !(value instanceof Date)) {
      for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
    } else search.append(key, value instanceof Date ? value.toISOString() : String(value));
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  const text = search.toString();
  return text ? `?${text}` : '';
};

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

/** JSON fetch with the bearer token. Throws ApiError with the server's message. */
export const api = async (path, { method = 'GET', body, query, signal, headers } = {}) => {
  const token = getToken();
  const res = await fetch(`${BASE}${path}${toQuery(query)}`, {
    method,
    signal,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, data);
  }
  return data;
};

export const apiUrl = (path) => `${BASE}${path}`;
