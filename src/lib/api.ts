export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const clerk = (window as any).Clerk
  if (clerk?.session) {
    const token = await clerk.session.getToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)
  }
  const res = await fetch(input, { ...init, headers, credentials: 'same-origin' })
  // No Clerk: the server's shared-secret gate answers 401 with { login: '/login' } when the access cookie is missing or expired
  if (res.status === 401 && !clerk && input.startsWith('/api/')) {
    const j = await res.clone().json().catch(() => null)
    if (j?.login) window.location.href = j.login
  }
  return res
}

export async function errorText(res: Response): Promise<string> {
  try {
    const j = await res.clone().json()
    return j.error || JSON.stringify(j)
  } catch {
    return res.statusText || `HTTP ${res.status}`
  }
}
