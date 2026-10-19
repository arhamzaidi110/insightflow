import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { AuthService, PublicUser } from './auth-service.js';

export const SESSION_COOKIE_NAME = 'insightflow_session';

export function readSessionCookie(request: Request): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name === SESSION_COOKIE_NAME) return valueParts.join('=') || undefined;
  }
  return undefined;
}

export function makeCsrfToken(sessionToken: string, secret: string): string {
  return createHmac('sha256', secret).update(sessionToken).digest('hex');
}

export function hasValidCsrfToken(sessionToken: string | undefined, supplied: string | undefined, secret: string): boolean {
  if (!sessionToken || !supplied || !/^[a-f\d]{64}$/i.test(supplied)) return false;
  const expected = Buffer.from(makeCsrfToken(sessionToken, secret), 'hex');
  const actual = Buffer.from(supplied, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function requireAuth(auth: AuthService): RequestHandler {
  return async (request, response, next) => {
    try {
      const user = await auth.getUserForSession(readSessionCookie(request));
      if (!user) {
        response.status(401).json({ error: 'Authentication required' });
        return;
      }
      response.locals.authUser = user satisfies PublicUser;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireSameOrigin(frontendOrigin: string): RequestHandler {
  return (request, response, next) => {
    if (request.get('origin') !== frontendOrigin) {
      response.status(403).json({ error: 'Request origin is not allowed' });
      return;
    }
    next();
  };
}

export function requireCsrf(secret: string): RequestHandler {
  return (request, response, next) => {
    const valid = hasValidCsrfToken(
      readSessionCookie(request),
      request.get('x-csrf-token'),
      secret,
    );
    if (!valid) {
      response.status(403).json({ error: 'Invalid or missing CSRF token' });
      return;
    }
    next();
  };
}

export function requireOwner(paramName = 'ownerId'): RequestHandler {
  return (request, response, next) => {
    const user = response.locals.authUser as PublicUser | undefined;
    if (!user || request.params[paramName] !== user.id) {
      response.status(404).json({ error: 'Resource not found' });
      return;
    }
    next();
  };
}
