import mongoose, { type Model } from 'mongoose';

interface StoredUser {
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new mongoose.Schema<StoredUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    passwordHash: { type: String, required: true, select: false },
  },
  { timestamps: true, versionKey: false },
);

export const UserModel = (mongoose.models.User as Model<StoredUser> | undefined) ?? mongoose.model<StoredUser>('User', userSchema);
