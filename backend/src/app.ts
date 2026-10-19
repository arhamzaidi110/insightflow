import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { config } from './config.js';
import { AuthService } from './auth/auth-service.js';
import { MongoAuthStore, type AuthStore } from './auth/auth-store.js';
import { createAuthRouter } from './auth/routes.js';
import { HttpAnalysisClient, AnalysisServiceError, type AnalysisClient } from './datasets/analysis-client.js';
import { MongoDatasetStore, type DatasetStore } from './datasets/dataset-store.js';
import { createDatasetRouter } from './datasets/routes.js';
import { GeminiQuestionPlanner, type QuestionPlanner } from './datasets/ai-assistant.js';
import { ApiError } from './http/api-error.js';
import multer from 'multer';
import { fileURLToPath } from 'node:url';

export function createApp(
  authStore: AuthStore = new MongoAuthStore(),
  datasetStore: DatasetStore = new MongoDatasetStore(),
  analysisClient: AnalysisClient = new HttpAnalysisClient(config.ANALYSIS_SERVICE_URL, config.ANALYSIS_SERVICE_TOKEN),
  questionPlanner: QuestionPlanner = new GeminiQuestionPlanner(config.GEMINI_API_KEY, config.GEMINI_MODEL),
) {
  const app = express();
  const auth = new AuthService(authStore);

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.FRONTEND_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', service: 'backend' });
  });
  app.use('/auth', createAuthRouter({
    auth,
    frontendOrigin: config.FRONTEND_ORIGIN,
    sessionSecret: config.SESSION_SECRET,
    secureCookies: config.NODE_ENV === 'production',
  }));
  app.use('/datasets', createDatasetRouter({
    auth,
    store: datasetStore,
    analysis: analysisClient,
    frontendOrigin: config.FRONTEND_ORIGIN,
    sessionSecret: config.SESSION_SECRET,
    secureCookies: config.NODE_ENV === 'production',
    storageRoot: path.resolve(config.UPLOAD_DIR),
    maxUploadBytes: config.MAX_UPLOAD_MB * 1024 * 1024,
    questionPlanner,
  }));
  if (config.NODE_ENV === 'production') {
    const frontendDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
    app.use(express.static(frontendDist));
  }
  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
    const candidate = error as { name?: string; type?: string; code?: string; statusCode?: number; publicMessage?: string };
    const isUnavailable = candidate.name === 'MongooseServerSelectionError';
    const isMulterError = error instanceof multer.MulterError;
    const status = candidate.type === 'entity.parse.failed'
      ? 400
      : isUnavailable
        ? 503
        : isMulterError && candidate.code === 'LIMIT_FILE_SIZE'
          ? 413
          : error instanceof ApiError || error instanceof AnalysisServiceError
            ? candidate.statusCode ?? 500
            : isMulterError
              ? 400
              : 500;
    console.error(JSON.stringify({ event: 'request_error', method: request.method, status }));
    response.status(status).json({
      error: candidate.publicMessage ?? (status === 400
        ? candidate.type === 'entity.parse.failed' ? 'Invalid JSON body' : 'Invalid upload request'
        : status === 413
          ? 'The uploaded file exceeds the configured size limit'
          : status === 503
            ? 'Service temporarily unavailable'
            : 'Unexpected server error'),
    });
  };
  app.use(errorHandler);

  return app;
}

export const app = createApp();
