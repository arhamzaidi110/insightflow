import mongoose, { type Model, type Types } from 'mongoose';

interface StoredSession {
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

const sessionSchema = new mongoose.Schema<StoredSession>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, select: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SessionModel = (mongoose.models.Session as Model<StoredSession> | undefined) ?? mongoose.model<StoredSession>('Session', sessionSchema);
