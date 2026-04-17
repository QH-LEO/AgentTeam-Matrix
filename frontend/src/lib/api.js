const API_BASE = "http://localhost:8787";

export function clonePayload(value) {
  return JSON.parse(JSON.stringify(value));
}

export async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`);
  return readResponse(response);
}

export async function apiPost(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readResponse(response);
}

export async function readResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.detail || payload.error || "请求失败";
    const error = new Error(message);
    error.payload = payload;
    throw error;
  }
  return payload;
}
