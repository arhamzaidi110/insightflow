import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Router, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { ApiError } from '../http/api-error.js';
import { analyticsPlanSchema, questionSchema } from './analytics-schema.js';
import { explainResult, GeminiQuestionPlanner, planDescription, type QuestionPlanner } from './ai-assistant.js';
import type { AuthService, PublicUser } from '../auth/auth-service.js';
import { requireAuth, requireCsrf, requireSameOrigin } from '../auth/security.js';
import type { AnalysisClient, AnalyticsPlan, DatasetPreview } from './analysis-client.js';
import type { DatasetStore } from './dataset-store.js';

const TICKET_TTL_MS = 30 * 60 * 1000;
const uploadNameSchema = z.object({
  uploadToken: z.string().uuid(),
  worksheet: z.string().min(1).max(31).optional(),
  datasetName: z.string().trim().min(1).max(120).optional(),
}).strict();
const previewSheetSchema = z.object({
  uploadToken: z.string().uuid(),
  worksheet: z.string().min(1).max(31),
}).strict();
const cleanOperationSchema = z.object({
  action: z.enum(['trim_whitespace', 'standardize_blanks', 'remove_duplicates', 'drop_columns', 'rename_column', 'convert_numeric', 'convert_date', 'fill_missing', 'filter_rows']),
  column: z.string().max(120).optional(), columns: z.array(z.string().max(120)).max(250).optional(), newName: z.string().max(120).optional(),
  method: z.enum(['mean', 'median', 'mode', 'constant']).optional(), value: z.union([z.string().max(500), z.number()]).optional(),
  operator: z.enum(['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte']).optional(), coerceFailures: z.boolean().optional(),
}).strict();
const cleanRequestSchema = z.object({ operation: cleanOperationSchema }).strict();
const cleanApplySchema = z.object({ operation: cleanOperationSchema, previewId: z.string().uuid() }).strict();
const datasetRenameSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
const savedAnalysisSchema = z.object({
  name: z.string().trim().min(1).max(80),
  configuration: z.object({ chartType: z.enum(['bar', 'line', 'trend', 'area', 'pie', 'donut', 'scatter', 'histogram']), title: z.string().trim().min(1).max(120), dimension: z.string().min(1).max(120), metric: z.string().max(120).optional(), aggregation: z.enum(['sum', 'average', 'count', 'min', 'max', 'median']), granularity: z.enum(['daily', 'monthly', 'quarterly', 'yearly']).optional(), filters: analyticsPlanSchema.shape.filters.optional() }).strict(),
}).strict();
const idSchema = z.string().uuid();
interface UploadTicket {
  ownerId: string;
  filePath: string;
  originalName: string;
  extension: 'csv' | 'xlsx';
  sizeBytes: number;
  expiresAt: number;
}

function cleanOriginalName(value: string): string {
  const basename = path.posix.basename(value.replace(/\\/g, '/'));
  const cleaned = [...basename]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 || '<>:"|?*'.includes(character) ? '_' : character;
    })
    .join('')
    .trim();
  return (cleaned || 'dataset').slice(0, 255);
}

function getUser(response: Response): PublicUser {
  return response.locals.authUser as PublicUser;
}

function activeStorageName(record: { workingStorageName?: string; storageName: string }): string {
  const name = record.workingStorageName ?? record.storageName;
  if (!/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:csv|xlsx)|working-[0-9a-f-]{36}\.csv)$/i.test(name)) throw new ApiError(404, 'Dataset not found.');
  return name;
}

export function assertPlanColumns(plan: AnalyticsPlan, columns: Array<{ name: string }>): void {
  const available = new Set(columns.map((column) => column.name));
  const requested = [plan.column, plan.groupBy, plan.dateColumn, ...(plan.columns ?? []), ...(plan.filters ?? []).map((filter) => filter.column)].filter((name): name is string => Boolean(name));
  if (requested.some((name) => !available.has(name))) throw new ApiError(400, 'The question references a column that does not exist in this dataset.');
}

function safeDatasetFiles(record: { storageName: string; workingStorageName?: string; cleaningHistory: Array<{ versionStorageName: string; previousStorageName?: string }> }): string[] {
  const names = [record.storageName, record.workingStorageName, ...record.cleaningHistory.flatMap((entry) => [entry.versionStorageName, entry.previousStorageName])];
  return [...new Set(names.filter((name): name is string => Boolean(name) && /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:csv|xlsx)|working-[0-9a-f-]{36}\.csv)$/i.test(name!)))];
}

async function removeFile(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => undefined);
}

export async function cleanupStaleTempFiles(storageRoot: string, olderThanMs = TICKET_TTL_MS): Promise<void> {
  const tempRoot = path.join(storageRoot, 'tmp');
  await mkdir(tempRoot, { recursive: true });
  const cutoff = Date.now() - olderThanMs;
  const entries = await readdir(tempRoot, { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const filePath = path.join(tempRoot, entry.name);
    const details = await stat(filePath).catch(() => null);
    if (details && details.mtimeMs < cutoff) await removeFile(filePath);
  }));
}

export function createDatasetRouter(options: {
  auth: AuthService;
  store: DatasetStore;
  analysis: AnalysisClient;
  frontendOrigin: string;
  sessionSecret: string;
  secureCookies: boolean;
  storageRoot: string;
  maxUploadBytes: number;
  questionPlanner?: QuestionPlanner;
}): Router {
  const router = Router();
  const tempRoot = path.join(options.storageRoot, 'tmp');
  const datasetRoot = path.join(options.storageRoot, 'datasets');
  const tickets = new Map<string, UploadTicket>();
  const cleanPreviews = new Map<string, { ownerId: string; datasetId: string; operationJson: string; expiresAt: number }>();
  const requireUser = requireAuth(options.auth);
  const requireOrigin = requireSameOrigin(options.frontendOrigin);
  const requireSessionCsrf = requireCsrf(options.sessionSecret);
  const questionPlanner = options.questionPlanner ?? new GeminiQuestionPlanner(undefined);
  const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many uploads. Try again later.' },
  });
  const analysisLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many analysis requests. Try again later.' } });
  const questionLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: (_request, response) => getUser(response).id, message: { error: 'AI question limit reached. Try again later.' } });

  router.get('/', requireUser, async (_request, response, next) => {
    try {
      const datasets = await options.store.listForOwner(getUser(response).id);
      response.set('Cache-Control', 'no-store').json({ datasets: datasets.map(({ id, name, originalName, fileType, sizeBytes, rowCount, columnCount, columns, worksheet, createdAt, workingStorageName }) => ({ id, name, originalName, fileType, sizeBytes, rowCount, columnCount, columns, worksheet, createdAt, status: workingStorageName ? 'modified' : 'ready' })) });
    } catch (error) { next(error); }
  });

  router.get('/:datasetId', requireUser, async (request, response, next) => {
    try {
      const id = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const record = id ? await options.store.findByIdForOwner(id, getUser(response).id) : null;
      if (!record) throw new ApiError(404, 'Dataset not found.');
      response.set('Cache-Control', 'no-store').json({ dataset: { id: record.id, name: record.name, originalName: record.originalName, fileType: record.fileType, sizeBytes: record.sizeBytes, rowCount: record.rowCount, columnCount: record.columnCount, columns: record.columns, worksheet: record.worksheet, createdAt: record.createdAt, status: record.workingStorageName ? 'modified' : 'ready', cleaningOperations: record.cleaningHistory.map(({ action, timestamp }) => ({ action, timestamp })) } });
    } catch (error) { next(error); }
  });

  router.patch('/:datasetId', requireUser, requireOrigin, requireSessionCsrf, async (request, response, next) => {
    try {
      const parsed = datasetRenameSchema.safeParse(request.body);
      if (!parsed.success) throw new ApiError(400, 'Dataset name must be between 1 and 120 characters.');
      const id = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const updated = id ? await options.store.updateForOwner(id, getUser(response).id, { name: parsed.data.name }) : null;
      if (!updated) throw new ApiError(404, 'Dataset not found.');
      response.json({ dataset: { id: updated.id, name: updated.name } });
    } catch (error) { next(error); }
  });

  router.delete('/:datasetId', requireUser, requireOrigin, requireSessionCsrf, async (request, response, next) => {
    try {
      const id = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const deleted = id ? await options.store.deleteForOwner(id, getUser(response).id) : null;
      if (!deleted) throw new ApiError(404, 'Dataset not found.');
      const removed = await Promise.all(safeDatasetFiles(deleted).map(async (name) => {
        try { await unlink(path.join(datasetRoot, name)); return true; }
        catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
      }));
      response.json({ deleted: true, storageCleanupComplete: removed.every(Boolean) });
    } catch (error) { next(error); }
  });

  router.get('/:datasetId/saved-analyses', requireUser, async (request, response, next) => {
    try {
      const id = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const record = id ? await options.store.findByIdForOwner(id, getUser(response).id) : null;
      if (!record) throw new ApiError(404, 'Dataset not found.');
      response.set('Cache-Control', 'no-store').json({ savedAnalyses: record.savedAnalyses ?? [] });
    } catch (error) { next(error); }
  });

  router.post('/:datasetId/saved-analyses', requireUser, requireOrigin, requireSessionCsrf, async (request, response, next) => {
    try {
      const parsed = savedAnalysisSchema.safeParse(request.body);
      if (!parsed.success) throw new ApiError(400, 'The saved analysis configuration is invalid.');
      const id = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const ownerId = getUser(response).id;
      const record = id ? await options.store.findByIdForOwner(id, ownerId) : null;
      if (!record) throw new ApiError(404, 'Dataset not found.');
      const configuration = parsed.data.configuration;
      if (configuration.chartType === 'scatter') {
        if (!configuration.metric) throw new ApiError(400, 'Scatter plots require two numeric columns.');
        const numericNames = new Set(record.columns.filter((column) => /number|integer|float|decimal/i.test(column.inferredType)).map((column) => column.name));
        if (!numericNames.has(configuration.dimension) || !numericNames.has(configuration.metric) || configuration.dimension === configuration.metric) throw new ApiError(400, 'Scatter plots require two different numeric columns.');
      }
      const savedPlan = configuration.chartType === 'trend'
        ? { operation: 'trend', dateColumn: configuration.dimension, ...(configuration.metric ? { column: configuration.metric } : {}), aggregation: configuration.aggregation, granularity: configuration.granularity ?? 'monthly', filters: configuration.filters }
        : configuration.chartType === 'scatter'
          ? { operation: 'correlation', columns: [configuration.dimension, configuration.metric!], filters: configuration.filters }
          : { operation: 'group_by', groupBy: configuration.dimension, ...(configuration.metric ? { column: configuration.metric } : {}), aggregation: configuration.aggregation, filters: configuration.filters };
      assertPlanColumns(savedPlan as AnalyticsPlan, record.columns);
      const entry = { id: randomUUID(), name: parsed.data.name, configuration: parsed.data.configuration, createdAt: new Date() };
      const updated = await options.store.updateForOwner(id!, ownerId, { savedAnalyses: [...(record.savedAnalyses ?? []), entry].slice(-100) });
      if (!updated) throw new ApiError(404, 'Dataset not found.');
      response.status(201).json({ savedAnalysis: entry });
    } catch (error) { next(error); }
  });

  router.delete('/:datasetId/saved-analyses/:analysisId', requireUser, requireOrigin, requireSessionCsrf, async (request, response, next) => {
    try {
      const id = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const analysisId = Array.isArray(request.params.analysisId) ? request.params.analysisId[0] : request.params.analysisId;
      if (!analysisId || !idSchema.safeParse(analysisId).success) throw new ApiError(404, 'Saved analysis not found.');
      const ownerId = getUser(response).id;
      const record = id ? await options.store.findByIdForOwner(id, ownerId) : null;
      if (!record) throw new ApiError(404, 'Dataset not found.');
      const current = record.savedAnalyses ?? [];
      const next = current.filter((item) => item.id !== analysisId);
      if (next.length === current.length) throw new ApiError(404, 'Saved analysis not found.');
      await options.store.updateForOwner(id!, ownerId, { savedAnalyses: next });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.get('/:datasetId/questions', requireUser, async (request, response, next) => {
    try {
      const id = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const record = id ? await options.store.findByIdForOwner(id, getUser(response).id) : null;
      if (!record) throw new ApiError(404, 'Dataset not found.');
      response.set('Cache-Control', 'no-store').json({ questions: record.questionHistory ?? [] });
    } catch (error) { next(error); }
  });

  router.delete('/:datasetId/questions', requireUser, requireOrigin, requireSessionCsrf, async (request, response, next) => {
    try {
      const id = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const updated = id ? await options.store.updateForOwner(id, getUser(response).id, { questionHistory: [] }) : null;
      if (!updated) throw new ApiError(404, 'Dataset not found.');
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.delete('/:datasetId/questions/:questionId', requireUser, requireOrigin, requireSessionCsrf, async (request, response, next) => {
    try {
      const id = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const questionId = Array.isArray(request.params.questionId) ? request.params.questionId[0] : request.params.questionId;
      if (!questionId || !idSchema.safeParse(questionId).success) throw new ApiError(404, 'Question history item not found.');
      const ownerId = getUser(response).id;
      const record = id ? await options.store.findByIdForOwner(id, ownerId) : null;
      if (!record) throw new ApiError(404, 'Dataset not found.');
      const current = record.questionHistory ?? [];
      const next = current.filter((item) => item.id !== questionId);
      if (next.length === current.length) throw new ApiError(404, 'Question history item not found.');
      await options.store.updateForOwner(id!, ownerId, { questionHistory: next });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.post('/:datasetId/export', requireUser, requireOrigin, requireSessionCsrf, analysisLimiter, async (request, response, next) => {
    try {
      const parsed = analyticsPlanSchema.safeParse(request.body?.plan);
      if (!parsed.success) throw new ApiError(400, 'The export plan is invalid.');
      const id = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const record = id ? await options.store.findByIdForOwner(id, getUser(response).id) : null;
      if (!record) throw new ApiError(404, 'Dataset not found.');
      assertPlanColumns(parsed.data as AnalyticsPlan, record.columns);
      const active = activeStorageName(record);
      const content = await options.analysis.exportCsv(path.join(datasetRoot, active), active.startsWith('working-') ? 'working.csv' : record.originalName, parsed.data as AnalyticsPlan, active.startsWith('working-') ? undefined : record.worksheet);
      response.set('Cache-Control', 'no-store').type('text/csv').attachment(`${record.name.replace(/[\\/:*?"<>|]/g, '_')}.csv`).send(content);
    } catch (error) { next(error); }
  });

  router.get('/:datasetId/profile', requireUser, async (request, response, next) => {
    try {
      const datasetId = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const record = datasetId ? await options.store.findByIdForOwner(datasetId, getUser(response).id) : null;
      if (!record) {
        response.status(404).json({ error: 'Dataset not found.' });
        return;
      }
      const activeName = activeStorageName(record);
      const profile = await options.analysis.profile(path.join(datasetRoot, activeName), activeName.startsWith('working-') ? 'working.csv' : record.originalName, activeName.startsWith('working-') ? undefined : record.worksheet);
      response.set('Cache-Control', 'no-store').json({ profile });
    } catch (error) { next(error); }
  });

  router.post('/:datasetId/analyze', requireUser, requireOrigin, requireSessionCsrf, analysisLimiter, async (request, response, next) => {
    try {
      const parsed = analyticsPlanSchema.safeParse(request.body);
      if (!parsed.success) throw new ApiError(400, 'Invalid analysis plan.');
      const id = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const record = id ? await options.store.findByIdForOwner(id, getUser(response).id) : null;
      if (!record) throw new ApiError(404, 'Dataset not found.');
      const active = activeStorageName(record);
      const result = await options.analysis.analyze(path.join(datasetRoot, active), active.startsWith('working-') ? 'working.csv' : record.originalName, parsed.data as AnalyticsPlan, active.startsWith('working-') ? undefined : record.worksheet);
      response.set('Cache-Control', 'no-store').json(result);
    } catch (error) { next(error); }
  });

  router.post('/:datasetId/ask', requireUser, requireOrigin, requireSessionCsrf, questionLimiter, async (request, response, next) => {
    try {
      const parsed = questionSchema.safeParse(request.body);
      if (!parsed.success) throw new ApiError(400, 'Enter a question between 3 and 500 characters.');
      const id = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const record = id ? await options.store.findByIdForOwner(id, getUser(response).id) : null;
      if (!record) throw new ApiError(404, 'Dataset not found.');
      const active = activeStorageName(record);
      const filename = active.startsWith('working-') ? 'working.csv' : record.originalName;
      const worksheet = active.startsWith('working-') ? undefined : record.worksheet;
      const preview = await options.analysis.preview(path.join(datasetRoot, active), filename, worksheet);
      const planned = await questionPlanner.createPlan(parsed.data, preview.columns);
      if (!planned.supported || !planned.plan) {
        await options.store.updateForOwner(id!, getUser(response).id, { questionHistory: [...(record.questionHistory ?? []), { id: randomUUID(), question: parsed.data.question, planSummary: 'unsupported', createdAt: new Date() }].slice(-20) });
        response.set('Cache-Control', 'no-store').json({ supported: false, clarification: planned.clarification, dataset: { id: record.id, name: record.name }, activeFilters: parsed.data.filters ?? [] });
        return;
      }
      const plan = { ...planned.plan, filters: [...(planned.plan.filters ?? []), ...(parsed.data.filters ?? [])] };
      const validPlan = analyticsPlanSchema.safeParse(plan);
      if (!validPlan.success) throw new ApiError(502, 'The generated plan could not be safely validated. Please rephrase your question.');
      assertPlanColumns(validPlan.data as AnalyticsPlan, preview.columns);
      const result = await options.analysis.analyze(path.join(datasetRoot, active), filename, validPlan.data as AnalyticsPlan, worksheet);
      await options.store.updateForOwner(id!, getUser(response).id, { questionHistory: [...(record.questionHistory ?? []), { id: randomUUID(), question: parsed.data.question, planSummary: planDescription(validPlan.data as AnalyticsPlan), createdAt: new Date() }].slice(-20) });
      response.set('Cache-Control', 'no-store').json({
        supported: true, answer: explainResult(parsed.data.question, validPlan.data as AnalyticsPlan, result),
        calculation: result, columnsUsed: [...new Set([validPlan.data.column, validPlan.data.groupBy, validPlan.data.dateColumn, ...(validPlan.data.columns ?? []), ...(validPlan.data.filters ?? []).map((item) => item.column)].filter((item): item is string => Boolean(item)))],
        planSummary: planDescription(validPlan.data as AnalyticsPlan), filters: validPlan.data.filters ?? [], warnings: Array.isArray(result.warnings) ? result.warnings : [],
        dataset: { id: record.id, name: record.name },
      });
    } catch (error) { next(error); }
  });

  router.post('/:datasetId/clean/preview', requireUser, requireOrigin, requireSessionCsrf, async (request, response, next) => {
    try {
      const parsed = cleanRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ApiError(400, 'Invalid cleaning operation.');
      const id = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const record = id ? await options.store.findByIdForOwner(id, getUser(response).id) : null;
      if (!record) throw new ApiError(404, 'Dataset not found.');
      const active = activeStorageName(record);
      const result = await options.analysis.clean(path.join(datasetRoot, active), active.startsWith('working-') ? 'working.csv' : record.originalName, parsed.data.operation, active.startsWith('working-') ? undefined : record.worksheet);
      const { contentBase64, ...safeResult } = result;
      void contentBase64;
      for (const [key, value] of cleanPreviews) if (value.expiresAt <= Date.now()) cleanPreviews.delete(key);
      const previewId = randomUUID();
      cleanPreviews.set(previewId, { ownerId: getUser(response).id, datasetId: record.id, operationJson: JSON.stringify(parsed.data.operation), expiresAt: Date.now() + 5 * 60 * 1000 });
      response.set('Cache-Control', 'no-store').json({ ...safeResult, operation: parsed.data.operation, previewId });
    } catch (error) { next(error); }
  });

  router.post('/:datasetId/clean/apply', requireUser, requireOrigin, requireSessionCsrf, async (request, response, next) => {
    let versionPath = '';
    try {
      const parsed = cleanApplySchema.safeParse(request.body);
      if (!parsed.success) throw new ApiError(400, 'Invalid cleaning operation.');
      const id = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const userId = getUser(response).id;
      const record = id ? await options.store.findByIdForOwner(id, userId) : null;
      if (!record) throw new ApiError(404, 'Dataset not found.');
      const approvedPreview = cleanPreviews.get(parsed.data.previewId);
      if (!approvedPreview || approvedPreview.ownerId !== userId || approvedPreview.datasetId !== record.id || approvedPreview.expiresAt <= Date.now() || approvedPreview.operationJson !== JSON.stringify(parsed.data.operation)) throw new ApiError(409, 'Preview expired or operation changed. Preview the change again before applying it.');
      cleanPreviews.delete(parsed.data.previewId);
      const active = activeStorageName(record);
      const operation = parsed.data.operation;
      const result = await options.analysis.clean(path.join(datasetRoot, active), active.startsWith('working-') ? 'working.csv' : record.originalName, operation, active.startsWith('working-') ? undefined : record.worksheet, true);
      const content = Buffer.from(result.contentBase64, 'base64');
      if (content.byteLength > options.maxUploadBytes) throw new ApiError(413, 'The cleaned version exceeds the configured file size limit.');
      const versionName = `working-${randomUUID()}.csv`;
      versionPath = path.join(datasetRoot, versionName);
      await writeFile(versionPath, content, { flag: 'wx', mode: 0o600 });
      const history = [...record.cleaningHistory, {
        action: operation.action, timestamp: new Date(), affectedRows: result.affectedRows, affectedColumns: result.affectedColumns,
        ...(operation.column ? { column: operation.column } : {}),
        parameters: Object.fromEntries(Object.entries(operation).filter(([key]) => ['columns', 'newName', 'method', 'operator', 'coerceFailures'].includes(key))),
        beforeRowCount: record.rowCount, beforeColumnCount: record.columnCount, beforeColumns: record.columns,
        versionStorageName: versionName,
        ...(record.workingStorageName ? { previousStorageName: record.workingStorageName } : {}),
      }];
      const updated = await options.store.updateForOwner(id!, userId, { workingStorageName: versionName, cleaningHistory: history, rowCount: result.after.rowCount, columnCount: result.after.columnCount, columns: result.columns });
      if (!updated) throw new ApiError(404, 'Dataset not found.');
      response.status(200).json({ before: result.before, after: result.after, affectedRows: result.affectedRows, affectedColumns: result.affectedColumns, warnings: result.warnings, profile: result.profile, history: updated.cleaningHistory.map(({ action, timestamp, affectedRows, affectedColumns, column }) => ({ action, timestamp, affectedRows, affectedColumns, ...(column ? { column } : {}) })) });
    } catch (error) { if (versionPath) await removeFile(versionPath); next(error); }
  });

  router.post('/:datasetId/clean/undo', requireUser, requireOrigin, requireSessionCsrf, async (request, response, next) => {
    try {
      const id = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const owner = getUser(response).id;
      const record = id ? await options.store.findByIdForOwner(id, owner) : null;
      if (!record || !record.cleaningHistory.length) throw new ApiError(404, 'There is no cleaning operation to undo.');
      const lastOperation = record.cleaningHistory.at(-1)!;
      const history = record.cleaningHistory.slice(0, -1);
      const previous = lastOperation.previousStorageName;
      const updated = await options.store.updateForOwner(id!, owner, { workingStorageName: previous ?? null, cleaningHistory: history, rowCount: lastOperation.beforeRowCount, columnCount: lastOperation.beforeColumnCount, columns: lastOperation.beforeColumns });
      if (!updated) throw new ApiError(404, 'Dataset not found.');
      await removeFile(path.join(datasetRoot, lastOperation.versionStorageName));
      response.json({ history: history.map(({ action, timestamp, affectedRows, affectedColumns, column }) => ({ action, timestamp, affectedRows, affectedColumns, ...(column ? { column } : {}) })), resetToOriginal: !previous });
    } catch (error) { next(error); }
  });

  router.post('/:datasetId/clean/reset', requireUser, requireOrigin, requireSessionCsrf, async (request, response, next) => {
    try {
      const id = Array.isArray(request.params.datasetId) ? request.params.datasetId[0] : request.params.datasetId;
      const owner = getUser(response).id;
      const record = id ? await options.store.findByIdForOwner(id, owner) : null;
      if (!record) throw new ApiError(404, 'Dataset not found.');
      const versions = record.cleaningHistory.map((item) => item.versionStorageName);
      const updated = await options.store.updateForOwner(id!, owner, { workingStorageName: null, cleaningHistory: [], rowCount: record.originalRowCount ?? record.rowCount, columnCount: record.originalColumnCount ?? record.columnCount, columns: record.originalColumns ?? record.columns });
      if (!updated) throw new ApiError(404, 'Dataset not found.');
      await Promise.all(versions.map((name) => removeFile(path.join(datasetRoot, name))));
      response.json({ resetToOriginal: true, history: [] });
    } catch (error) { next(error); }
  });

  const storage = multer.diskStorage({
    destination: (_request, _file, callback) => {
      mkdir(tempRoot, { recursive: true }).then(() => callback(null, tempRoot), (error: Error) => callback(error, tempRoot));
    },
    filename: (_request, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      callback(null, `${randomUUID()}${extension}`);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: options.maxUploadBytes, files: 1, fields: 0, parts: 1, fieldNameSize: 100, headerPairs: 100 },
    fileFilter: (_request, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      const mime = file.mimetype.toLowerCase();
      const csvMimes = new Set(['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream']);
      const xlsxMimes = new Set([
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/octet-stream',
      ]);
      if (extension === '.csv' && csvMimes.has(mime)) return callback(null, true);
      if (extension === '.xlsx' && xlsxMimes.has(mime)) return callback(null, true);
      callback(new ApiError(415, 'Only CSV and XLSX files with a supported content type are accepted.'));
    },
  });

  const removeExpiredTickets: RequestHandler = async (_request, _response, next) => {
    const now = Date.now();
    const expired = [...tickets.entries()].filter(([, ticket]) => ticket.expiresAt <= now);
    for (const [token, ticket] of expired) {
      tickets.delete(token);
      await removeFile(ticket.filePath);
    }
    next();
  };

  router.post(
    '/preview',
    requireUser,
    requireOrigin,
    requireSessionCsrf,
    uploadLimiter,
    removeExpiredTickets,
    upload.single('file'),
    async (request, response, next) => {
      const file = request.file;
      if (!file) {
        response.status(400).json({ error: 'Choose a CSV or XLSX file to upload.' });
        return;
      }
      const originalName = cleanOriginalName(file.originalname);
      const extension = path.extname(originalName).toLowerCase().slice(1) as 'csv' | 'xlsx';
      try {
        const analysis = await options.analysis.preview(file.path, originalName);
        const uploadToken = randomUUID();
        tickets.set(uploadToken, {
          ownerId: getUser(response).id,
          filePath: file.path,
          originalName,
          extension,
          sizeBytes: file.size,
          expiresAt: Date.now() + TICKET_TTL_MS,
        });
        response.status(200).json({ uploadToken, originalName, sizeBytes: file.size, ...analysis });
      } catch (error) {
        await removeFile(file.path);
        next(error);
      }
    },
  );

  router.post('/preview-sheet', requireUser, requireOrigin, requireSessionCsrf, uploadLimiter, async (request, response, next) => {
    const parsed = previewSheetSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Invalid worksheet selection.' });
      return;
    }
    const ticket = tickets.get(parsed.data.uploadToken);
    if (!ticket || ticket.ownerId !== getUser(response).id || ticket.expiresAt <= Date.now()) {
      response.status(404).json({ error: 'Upload preview expired. Upload the file again.' });
      return;
    }
    if (ticket.extension !== 'xlsx') {
      response.status(400).json({ error: 'Worksheet selection is only available for Excel workbooks.' });
      return;
    }
    try {
      const analysis = await options.analysis.preview(ticket.filePath, ticket.originalName, parsed.data.worksheet);
      response.set('Cache-Control', 'no-store').json({ uploadToken: parsed.data.uploadToken, ...analysis });
    } catch (error) {
      next(error);
    }
  });

  router.post('/import', requireUser, requireOrigin, requireSessionCsrf, uploadLimiter, async (request, response, next) => {
    const parsed = uploadNameSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Invalid import request.' });
      return;
    }
    const ticket = tickets.get(parsed.data.uploadToken);
    if (!ticket || ticket.ownerId !== getUser(response).id || ticket.expiresAt <= Date.now()) {
      response.status(404).json({ error: 'Upload preview expired. Upload the file again.' });
      return;
    }
    if (ticket.extension === 'csv' && parsed.data.worksheet) {
      response.status(400).json({ error: 'CSV files do not have worksheets.' });
      return;
    }

    let analysis: DatasetPreview;
    try {
      analysis = await options.analysis.preview(ticket.filePath, ticket.originalName, parsed.data.worksheet);
    } catch (error) {
      next(error);
      return;
    }

    const storageName = `${randomUUID()}.${ticket.extension}`;
    const finalPath = path.join(datasetRoot, storageName);
    await mkdir(datasetRoot, { recursive: true });
    try {
      await rename(ticket.filePath, finalPath);
    } catch (error) {
      next(error);
      return;
    }

    const baseName = ticket.originalName.replace(/\.[^.]+$/, '');
    const datasetName = parsed.data.datasetName ?? (baseName.slice(0, 120) || 'Dataset');
    try {
      const record = await options.store.create({
        ownerId: ticket.ownerId,
        name: datasetName,
        originalName: ticket.originalName,
        storageName,
        fileType: ticket.extension,
        sizeBytes: ticket.sizeBytes,
        rowCount: analysis.rowCount,
        columnCount: analysis.columnCount,
        columns: analysis.columns,
        originalRowCount: analysis.rowCount,
        originalColumnCount: analysis.columnCount,
        originalColumns: analysis.columns,
        ...(analysis.selectedSheet ? { worksheet: analysis.selectedSheet } : {}),
      });
      tickets.delete(parsed.data.uploadToken);
      response.status(201).json({
        dataset: {
          id: record.id,
          name: record.name,
          originalName: record.originalName,
          fileType: record.fileType,
          sizeBytes: record.sizeBytes,
          rowCount: record.rowCount,
          columnCount: record.columnCount,
          columns: record.columns,
          worksheet: record.worksheet,
          createdAt: record.createdAt.toISOString(),
        },
      });
    } catch (error) {
      await rename(finalPath, ticket.filePath).catch(() => removeFile(finalPath));
      next(error);
    }
  });

  return router;
}
