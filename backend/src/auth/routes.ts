import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { AuthService } from './auth-service.js';
import { SESSION_COOKIE_NAME, makeCsrfToken, readSessionCookie, requireAuth, requireCsrf, requireSameOrigin } from './security.js';

const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 UTF-8 bytes');
const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: passwordSchema,
}).strict();
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
}).strict();

function validationError(response: Response, issues: { path: PropertyKey[]; message: string }[]) {
  response.status(400).json({
    error: 'Invalid request body',
    details: issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
  });
}

function setSessionCookie(response: Response, token: string, secure: boolean): void {
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  const fields = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAge / 1000)}`,
  ];
  if (secure) fields.push('Secure');
  response.append('Set-Cookie', fields.join('; '));
}

function clearSessionCookie(response: Response, secure: boolean): void {
  const fields = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) fields.push('Secure');
  response.append('Set-Cookie', fields.join('; '));
}

export function createAuthRouter(options: {
  auth: AuthService;
  frontendOrigin: string;
  sessionSecret: string;
  secureCookies: boolean;
}): Router {
  const router = Router();
  const requireUser = requireAuth(options.auth);
  const requireOrigin = requireSameOrigin(options.frontendOrigin);
  const signupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts. Try again later.' },
  });
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts. Try again later.' },
  });

  router.post('/signup', signupLimiter, requireOrigin, async (request, response) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) {
      validationError(response, parsed.error.issues);
      return;
    }
    const session = await options.auth.register(parsed.data.email, parsed.data.password);
    if (!session) {
      response.status(400).json({ error: 'Unable to create account with these details' });
      return;
    }
    setSessionCookie(response, session.token, options.secureCookies);
    response.status(201).json({
      user: session.user,
      csrfToken: makeCsrfToken(session.token, options.sessionSecret),
    });
  });

  router.post('/login', loginLimiter, requireOrigin, async (request, response) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      validationError(response, parsed.error.issues);
      return;
    }
    const session = await options.auth.login(parsed.data.email, parsed.data.password);
    if (!session) {
      response.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    setSessionCookie(response, session.token, options.secureCookies);
    response.json({
      user: session.user,
      csrfToken: makeCsrfToken(session.token, options.sessionSecret),
    });
  });

  router.get('/me', requireUser, (_request, response) => {
    response.set('Cache-Control', 'no-store').json({ user: response.locals.authUser });
  });

  router.get('/csrf', requireUser, (request, response) => {
    const token = readSessionCookie(request);
    if (!token) {
      response.status(401).json({ error: 'Authentication required' });
      return;
    }
    response.set('Cache-Control', 'no-store').json({ csrfToken: makeCsrfToken(token, options.sessionSecret) });
  });

  router.post('/logout', requireUser, requireOrigin, requireCsrf(options.sessionSecret), async (request, response) => {
    await options.auth.logout(readSessionCookie(request));
    clearSessionCookie(response, options.secureCookies);
    response.status(204).end();
  });

  return router;
}
