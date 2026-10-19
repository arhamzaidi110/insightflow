import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Workspace scripts run from backend/, while the shared development .env lives
// at the repository root. Resolve it from this file in both src/ and dist/.
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BACKEND_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  FRONTEND_ORIGIN: z.string().url().default('http://127.0.0.1:5173'),
  ANALYSIS_SERVICE_URL: z.string().url().default('http://127.0.0.1:8000'),
  ANALYSIS_SERVICE_TOKEN: z.string().optional(),
  MONGODB_URI: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().trim().min(1).max(100).default('gemini-2.5-flash'),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().max(250).default(25),
  UPLOAD_DIR: z.string().min(1).default('uploads'),
  SESSION_SECRET: z.string().min(32).default('development-only-change-this-session-secret'),
});

const parsed = configSchema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`Invalid backend configuration: ${details}. Check the root .env.example.`);
}

export const config = parsed.data;

if (
  config.NODE_ENV === 'production' &&
  (config.SESSION_SECRET === 'development-only-change-this-session-secret' ||
    config.SESSION_SECRET.startsWith('replace-with-'))
) {
  throw new Error('SESSION_SECRET must be set to a unique random value in production. Check the root .env.example.');
}
