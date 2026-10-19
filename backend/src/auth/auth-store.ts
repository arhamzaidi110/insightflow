import { SessionModel } from '../models/session.js';
import { UserModel } from '../models/user.js';

export interface UserAccount {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

export interface SessionRecord {
  userId: string;
  expiresAt: Date;
}

export interface AuthStore {
  findUserByEmail(email: string): Promise<UserAccount | null>;
  findUserById(id: string): Promise<UserAccount | null>;
  createUser(email: string, passwordHash: string): Promise<UserAccount>;
  createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  deleteSessionByTokenHash(tokenHash: string): Promise<void>;
}

function accountFrom(value: {
  _id: { toString(): string };
  email: string;
  passwordHash?: string;
  createdAt: Date;
}): UserAccount {
  return {
    id: value._id.toString(),
    email: value.email,
    passwordHash: value.passwordHash ?? '',
    createdAt: value.createdAt,
  };
}

export class MongoAuthStore implements AuthStore {
  async findUserByEmail(email: string): Promise<UserAccount | null> {
    const value = await UserModel.findOne({ email }).select('+passwordHash').exec();
    return value ? accountFrom(value) : null;
  }

  async findUserById(id: string): Promise<UserAccount | null> {
    if (!/^[a-f\d]{24}$/i.test(id)) return null;
    const value = await UserModel.findById(id).select('+passwordHash').exec();
    return value ? accountFrom(value) : null;
  }

  async createUser(email: string, passwordHash: string): Promise<UserAccount> {
    const value = await UserModel.create({ email, passwordHash });
    return accountFrom(value);
  }

  async createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await SessionModel.create({ userId, tokenHash, expiresAt });
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const value = await SessionModel.findOne({ tokenHash }).select('+tokenHash').lean().exec();
    return value ? { userId: value.userId.toString(), expiresAt: value.expiresAt } : null;
  }

  async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
    await SessionModel.deleteOne({ tokenHash }).exec();
  }
}

export function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
