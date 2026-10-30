
// Clerk auth for Fastify - verifies token, optional for free tier
import { verifyToken } from '@clerk/backend'

export async function authenticateClerk(req: any) {
  const secret = process.env.CLERK_SECRET_KEY
  if (!secret) return { userId: null, authenticated: false, reason: 'No CLERK_SECRET_KEY - running open' }

  const authHeader = String(req.headers.authorization || req.headers['x-clerk-auth'] || '')
  const token = authHeader.replace(/^Bearer\s+/i, '').trim() || req.cookies?.__session || sessionCookie(req.headers.cookie)

  if (!token) return { userId: null, authenticated: false, reason: 'No token' }
  // Only JWTs can be Clerk session tokens; anything else (e.g. the workspace access token) is not ours to verify
  if (token.split('.').length !== 3) return { userId: null, authenticated: false, reason: 'Not a Clerk token' }

  try {
    const payload = await verifyToken(token, { secretKey: secret })
    return { userId: payload.sub, authenticated: true, payload }
  } catch (e: any) {
    console.warn('Clerk verify failed', e.message)
    return { userId: null, authenticated: false, reason: e.message }
  }
}

function sessionCookie(header: unknown): string {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === '__session') return decodeURIComponent(part.slice(i + 1).trim())
  }
  return ''
}

export function clerkPreHandler() {
  return async (req: any, reply: any) => {
    const auth = await authenticateClerk(req)
    req.clerkAuth = auth
    // Don't block - allow free runs, but attach userId if present
    // To enforce auth: if (!auth.authenticated) return reply.status(401).send({error:'Unauthorized'})
  }
}
