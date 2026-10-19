import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth/auth-service.js';
import type { AuthStore, SessionRecord, UserAccount } from './auth/auth-store.js';
import { createAuthRouter } from './auth/routes.js';
import { requireAuth, requireOwner } from './auth/security.js';
import { app } from './app.js';

const ORIGIN = 'http://127.0.0.1:5173';
const SECRET = 'test-only-session-secret-value-123456';

class MemoryAuthStore implements AuthStore {
  users = new Map<string, UserAccount>();
  sessions = new Map<string, SessionRecord>();
  private nextId = 1;

  async findUserByEmail(email: string) {
    return [...this.users.values()].find((user) => user.email === email) ?? null;
  }
  async findUserById(id: string) {
    return this.users.get(id) ?? null;
  }
  async createUser(email: string, passwordHash: string) {
    if ([...this.users.values()].some((user) => user.email === email)) {
      throw Object.assign(new Error('duplicate key'), { code: 11000 });
    }
    const user = { id: String(this.nextId++), email, passwordHash, createdAt: new Date() };
    this.users.set(user.id, user);
    return user;
  }
  async createSession(userId: string, tokenHash: string, expiresAt: Date) {
    this.sessions.set(tokenHash, { userId, expiresAt });
  }
  async findSessionByTokenHash(tokenHash: string) {
    return this.sessions.get(tokenHash) ?? null;
  }
  async deleteSessionByTokenHash(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }
}

const servers: ReturnType<ReturnType<typeof express>['listen']>[] = [];

async function startServer(handler: express.Express) {
  const server = handler.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function cookieFrom(response: Response): string {
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('Expected a session cookie');
  return cookie.split(';')[0]!;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('backend health endpoint', () => {
  it('reports the service as healthy', async () => {
    const base = await startServer(app);
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'backend' });
  });
});

describe('authentication API', () => {
  const makeAuthApp = (store: MemoryAuthStore) => {
    const serverApp = express();
    serverApp.use(express.json());
    serverApp.use('/auth', createAuthRouter({
      auth: new AuthService(store), frontendOrigin: ORIGIN, sessionSecret: SECRET, secureCookies: false,
    }));
    return serverApp;
  };

  it('registers a user, hashes the password, and issues a protected cookie', async () => {
    const store = new MemoryAuthStore();
    const base = await startServer(makeAuthApp(store));
    const response = await fetch(`${base}/auth/signup`, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: '  TEST@example.com ', password: 'correct horse battery staple' }),
    });
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.user.email).toBe('test@example.com');
    expect(body.user.passwordHash).toBeUndefined();
    expect(typeof body.csrfToken).toBe('string');
    expect(store.users.get(body.user.id)?.passwordHash).not.toBe('correct horse battery staple');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=Strict');
  });

  it('rejects invalid signup input and does not reveal duplicate-account details', async () => {
    const store = new MemoryAuthStore();
    const base = await startServer(makeAuthApp(store));
    const send = (email: string, password: string) => fetch(`${base}/auth/signup`, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect((await send('bad-email', 'short')).status).toBe(400);
    await send('repeat@example.com', 'correct horse battery staple');
    const duplicate = await send('repeat@example.com', 'correct horse battery staple');
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: 'Unable to create account with these details' });
  });

  it('logs in with the same generic error for unknown email and wrong password', async () => {
    const store = new MemoryAuthStore();
    const base = await startServer(makeAuthApp(store));
    const post = (email: string, password: string) => fetch(`${base}/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    await fetch(`${base}/auth/signup`, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.com', password: 'correct horse battery staple' }),
    });
    const wrongPassword = await post('person@example.com', 'wrong password value');
    const unknownEmail = await post('nobody@example.com', 'wrong password value');
    expect(wrongPassword.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(await unknownEmail.json());
    const login = await post('PERSON@example.com', 'correct horse battery staple');
    expect(login.status).toBe(200);
    expect((await login.json()).user.email).toBe('person@example.com');
  });

  it('requires authentication for current-user access and revokes sessions on logout', async () => {
    const store = new MemoryAuthStore();
    const base = await startServer(makeAuthApp(store));
    const unauthenticated = await fetch(`${base}/auth/me`);
    expect(unauthenticated.status).toBe(401);
    const signup = await fetch(`${base}/auth/signup`, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.com', password: 'correct horse battery staple' }),
    });
    const cookie = cookieFrom(signup);
    const csrfToken = (await signup.json()).csrfToken as string;
    const invalidCsrf = await fetch(`${base}/auth/logout`, {
      method: 'POST', headers: { origin: ORIGIN, cookie },
    });
    expect(invalidCsrf.status).toBe(403);
    expect((await fetch(`${base}/auth/me`, { headers: { cookie } })).status).toBe(200);
    const logout = await fetch(`${base}/auth/logout`, {
      method: 'POST', headers: { origin: ORIGIN, cookie, 'x-csrf-token': csrfToken },
    });
    expect(logout.status).toBe(204);
    expect((await fetch(`${base}/auth/me`, { headers: { cookie } })).status).toBe(401);
  });

  it('blocks cross-user access through the reusable ownership middleware', async () => {
    const store = new MemoryAuthStore();
    const service = new AuthService(store);
    const protectedApp = express();
    protectedApp.use(express.json());
    protectedApp.use('/auth', createAuthRouter({ auth: service, frontendOrigin: ORIGIN, sessionSecret: SECRET, secureCookies: false }));
    protectedApp.get('/owned/:ownerId', requireAuth(service), requireOwner(), (_request, response) => response.json({ ok: true }));
    const base = await startServer(protectedApp);
    const signup = await fetch(`${base}/auth/signup`, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery staple' }),
    });
    const cookie = cookieFrom(signup);
    const ownerId = (await signup.json()).user.id as string;
    expect((await fetch(`${base}/owned/${ownerId}`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/owned/someone-else`, { headers: { cookie } })).status).toBe(404);
  });
});
