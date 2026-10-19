import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthStore, UserAccount } from './auth-store.js';
import { isDuplicateKeyError } from './auth-store.js';

const PASSWORD_COST = 12;
const SESSION_DAYS = 7;
const dummyPasswordHash = bcrypt.hashSync(randomBytes(32).toString('hex'), PASSWORD_COST);

export interface PublicUser {
  id: string;
  email: string;
  createdAt: string;
}

export interface IssuedSession {
  token: string;
  user: PublicUser;
}

function toPublicUser(user: UserAccount): PublicUser {
  return { id: user.id, email: user.email, createdAt: user.createdAt.toISOString() };
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class AuthService {
  constructor(private readonly store: AuthStore) {}

  async register(email: string, password: string): Promise<IssuedSession | null> {
    const passwordHash = await bcrypt.hash(password, PASSWORD_COST);

    try {
      const user = await this.store.createUser(email, passwordHash);
      return await this.issueSession(user);
    } catch (error) {
      if (isDuplicateKeyError(error)) return null;
      throw error;
    }
  }

  async login(email: string, password: string): Promise<IssuedSession | null> {
    const user = await this.store.findUserByEmail(email);
    const passwordMatches = await bcrypt.compare(password, user?.passwordHash || dummyPasswordHash);
    if (!user || !passwordMatches) return null;
    return this.issueSession(user);
  }

  async getUserForSession(token: string | undefined): Promise<PublicUser | null> {
    if (!token || token.length > 128) return null;
    const session = await this.store.findSessionByTokenHash(hashSessionToken(token));
    if (!session) return null;
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.store.deleteSessionByTokenHash(hashSessionToken(token));
      return null;
    }
    const user = await this.store.findUserById(session.userId);
    return user ? toPublicUser(user) : null;
  }

  async logout(token: string | undefined): Promise<void> {
    if (token && token.length <= 128) {
      await this.store.deleteSessionByTokenHash(hashSessionToken(token));
    }
  }

  private async issueSession(user: UserAccount): Promise<IssuedSession> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    await this.store.createSession(user.id, hashSessionToken(token), expiresAt);
    return { token, user: toPublicUser(user) };
  }
}

export { SESSION_DAYS };
