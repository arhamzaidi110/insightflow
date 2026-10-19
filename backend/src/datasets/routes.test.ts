import express, { type ErrorRequestHandler } from 'express';
import multer from 'multer';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../auth/auth-service.js';
import type { AuthStore, SessionRecord, UserAccount } from '../auth/auth-store.js';
import { createAuthRouter } from '../auth/routes.js';
import { ApiError } from '../http/api-error.js';
import { AnalysisServiceError, type AnalysisClient, type DatasetPreview } from './analysis-client.js';
import type { AnalyticsPlan } from './analysis-client.js';
import type { QuestionPlanner } from './ai-assistant.js';
import { createDatasetRouter } from './routes.js';
import type { DatasetRecord, DatasetStore, NewDataset } from './dataset-store.js';

const ORIGIN = 'http://127.0.0.1:5173';
const SECRET = 'dataset-test-session-secret-value-123';
const preview: DatasetPreview = {
  rowCount: 1,
  columnCount: 2,
  columns: [{ name: 'region', inferredType: 'string' }, { name: 'revenue', inferredType: 'integer' }],
  preview: [{ region: 'east', revenue: 12 }],
  warnings: [],
  sheets: [],
  selectedSheet: null,
  profile: { rowCount: 1, columnCount: 2, duplicateRowCount: 0, columns: [], warnings: [] },
};

class MemoryAuthStore implements AuthStore {
  users = new Map<string, UserAccount>();
  sessions = new Map<string, SessionRecord>();
  private counter = 0;
  async findUserByEmail(email: string) { return [...this.users.values()].find((user) => user.email === email) ?? null; }
  async findUserById(id: string) { return this.users.get(id) ?? null; }
  async createUser(email: string, passwordHash: string) {
    if (await this.findUserByEmail(email)) throw Object.assign(new Error('duplicate'), { code: 11000 });
    const user = { id: `user-${++this.counter}`, email, passwordHash, createdAt: new Date() };
    this.users.set(user.id, user);
    return user;
  }
  async createSession(userId: string, tokenHash: string, expiresAt: Date) { this.sessions.set(tokenHash, { userId, expiresAt }); }
  async findSessionByTokenHash(tokenHash: string) { return this.sessions.get(tokenHash) ?? null; }
  async deleteSessionByTokenHash(tokenHash: string) { this.sessions.delete(tokenHash); }
}

class MemoryDatasetStore implements DatasetStore {
  records: DatasetRecord[] = [];
  async listForOwner(ownerId: string) { return this.records.filter((record) => record.ownerId === ownerId); }
  async create(dataset: NewDataset) {
    const record = { ...dataset, originalRowCount: dataset.rowCount, originalColumnCount: dataset.columnCount, originalColumns: dataset.columns, cleaningHistory: [], savedAnalyses: [], questionHistory: [], id: `dataset-${this.records.length + 1}`, createdAt: new Date() };
    this.records.push(record);
    return record;
  }
  async findByIdForOwner(id: string, ownerId: string) { return this.records.find((record) => record.id === id && record.ownerId === ownerId) ?? null; }
  async updateForOwner(id: string, ownerId: string, update: Parameters<DatasetStore['updateForOwner']>[2]) {
    const record = this.records.find((item) => item.id === id && item.ownerId === ownerId);
    if (!record) return null;
    if (update.workingStorageName === null) delete record.workingStorageName;
    else if (update.workingStorageName) record.workingStorageName = update.workingStorageName;
    if (update.cleaningHistory) record.cleaningHistory = update.cleaningHistory;
    if (update.rowCount !== undefined) record.rowCount = update.rowCount;
    if (update.columnCount !== undefined) record.columnCount = update.columnCount;
    if (update.columns) record.columns = update.columns;
    if (update.name) record.name = update.name;
    if (update.savedAnalyses) record.savedAnalyses = update.savedAnalyses;
    if (update.questionHistory) record.questionHistory = update.questionHistory;
    return record;
  }
  async deleteForOwner(id: string, ownerId: string) {
    const index = this.records.findIndex((item) => item.id === id && item.ownerId === ownerId);
    return index < 0 ? null : this.records.splice(index, 1)[0]!;
  }
}

class FakeAnalysisClient implements AnalysisClient {
  calls: { filename: string; worksheet?: string; bytes: Buffer }[] = [];
  async preview(filePath: string, filename: string, worksheet?: string) {
    this.calls.push({ filename, worksheet, bytes: await readFile(filePath) });
    if (filename.endsWith('.xlsx')) {
      return { ...preview, sheets: ['Sales', 'Details'], selectedSheet: worksheet ?? 'Sales' };
    }
    return preview;
  }
  async profile(filePath: string, filename: string, worksheet?: string) {
    await this.preview(filePath, filename, worksheet);
    return preview.profile;
  }
  async clean(filePath: string, filename: string, operation: Record<string, unknown>, worksheet?: string) {
    await this.preview(filePath, filename, worksheet);
    return { before: { rowCount: 1, columnCount: 2 }, after: { rowCount: 1, columnCount: 2 }, affectedRows: 0, affectedColumns: 0, warnings: [], preview: preview.preview, columns: preview.columns, profile: preview.profile, contentBase64: Buffer.from('region,revenue\neast,12\n').toString('base64') };
  }
  async analyze(filePath: string, filename: string, plan: AnalyticsPlan, worksheet?: string) {
    await this.preview(filePath, filename, worksheet);
    if (plan.operation === 'group_by') return { operation: plan.operation, appliedFilters: plan.filters ?? [], groups: [{ group: 'east', value: 12, rowCount: 1 }], rowCount: 1, warnings: [] };
    return { operation: plan.operation, appliedFilters: plan.filters ?? [], rowsRead: 1 };
  }
  async exportCsv() { return Buffer.from('\uFEFFregion,revenue\neast,12\n'); }
}

class FakeQuestionPlanner implements QuestionPlanner {
  response: { supported: boolean; clarification: string; plan: AnalyticsPlan | null } = { supported: true, clarification: '', plan: { operation: 'group_by', groupBy: 'region', column: 'revenue', aggregation: 'sum' } };
  calls: Array<{ question: string; columns: string[] }> = [];
  async createPlan(question: { question: string }, columns: Array<{ name: string; inferredType: string }>) {
    this.calls.push({ question: question.question, columns: columns.map((column) => column.name) });
    return this.response;
  }
}

let storageRoot = '';
let server: ReturnType<ReturnType<typeof express>['listen']> | undefined;
let baseUrl = '';
let authStore: MemoryAuthStore;
let datasetStore: MemoryDatasetStore;
let analysis: FakeAnalysisClient;
let questionPlanner: FakeQuestionPlanner;

async function jsonRequest(pathname: string, body: unknown, cookie?: string, csrf?: string) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    body: JSON.stringify(body),
  });
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('Expected session cookie');
  return cookie.split(';')[0]!;
}

async function signUp(email: string) {
  const response = await jsonRequest('/auth/signup', { email, password: 'correct horse battery staple' });
  const body = await response.json();
  return { cookie: sessionCookie(response), csrf: body.csrfToken as string, userId: body.user.id as string };
}

async function uploadCsv(cookie: string, csrf: string) {
  const form = new FormData();
  form.append('file', new Blob(['region,revenue\neast,12\n'], { type: 'text/csv' }), 'sales.csv');
  return fetch(`${baseUrl}/datasets/preview`, {
    method: 'POST',
    headers: { origin: ORIGIN, cookie, 'x-csrf-token': csrf },
    body: form,
  });
}

beforeEach(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'insightflow-upload-test-'));
  authStore = new MemoryAuthStore();
  datasetStore = new MemoryDatasetStore();
  analysis = new FakeAnalysisClient();
  questionPlanner = new FakeQuestionPlanner();
  const api = express();
  const auth = new AuthService(authStore);
  api.use(express.json());
  api.use('/auth', createAuthRouter({ auth, frontendOrigin: ORIGIN, sessionSecret: SECRET, secureCookies: false }));
  api.use('/datasets', createDatasetRouter({
    auth, store: datasetStore, analysis, frontendOrigin: ORIGIN, sessionSecret: SECRET,
    secureCookies: false, storageRoot, maxUploadBytes: 1024, questionPlanner,
  }));
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof ApiError || error instanceof AnalysisServiceError) {
      response.status(error.statusCode).json({ error: error.publicMessage });
    } else if (error instanceof multer.MulterError) {
      response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Upload failed.' });
    } else {
      response.status(500).json({ error: 'Unexpected server error' });
    }
  };
  api.use(errorHandler);
  server = api.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  }
  await rm(storageRoot, { recursive: true, force: true });
});

describe('dataset upload API', () => {
  it('requires an authenticated, CSRF-protected session before accepting a file', async () => {
    const form = new FormData();
    form.append('file', new Blob(['a,b\n1,2\n']), 'data.csv');
    const response = await fetch(`${baseUrl}/datasets/preview`, {
      method: 'POST', headers: { origin: ORIGIN }, body: form,
    });
    expect(response.status).toBe(401);
  });

  it('previews an upload and imports the immutable file into private owner-bound storage', async () => {
    const account = await signUp('owner@example.com');
    const uploaded = await uploadCsv(account.cookie, account.csrf);
    expect(uploaded.status).toBe(200);
    const previewBody = await uploaded.json();
    expect(previewBody.rowCount).toBe(1);
    expect(previewBody.preview[0].region).toBe('east');
    expect(previewBody.originalName).toBe('sales.csv');
    expect(analysis.calls[0]?.bytes.toString()).toContain('east,12');

    const imported = await jsonRequest(
      '/datasets/import',
      { uploadToken: previewBody.uploadToken, datasetName: 'Quarterly sales' },
      account.cookie,
      account.csrf,
    );
    expect(imported.status).toBe(201);
    const dataset = (await imported.json()).dataset;
    expect(dataset.name).toBe('Quarterly sales');
    expect(dataset.rowCount).toBe(1);
    expect(datasetStore.records[0]?.ownerId).toBe(account.userId);
    expect(datasetStore.records[0]?.storageName).toMatch(/^[\da-f-]+\.csv$/i);
    const listed = await fetch(`${baseUrl}/datasets`, { headers: { cookie: account.cookie } });
    expect(listed.status).toBe(200);
    expect((await listed.json()).datasets.map((item: { id: string }) => item.id)).toContain(dataset.id);
    expect(analysis.calls).toHaveLength(2);
  });

  it('returns data profiles only to the owning account', async () => {
    const owner = await signUp('profile-owner@example.com');
    const other = await signUp('profile-other@example.com');
    const upload = await uploadCsv(owner.cookie, owner.csrf);
    const ticket = (await upload.json()).uploadToken as string;
    const imported = await jsonRequest('/datasets/import', { uploadToken: ticket }, owner.cookie, owner.csrf);
    const datasetId = (await imported.json()).dataset.id as string;
    const ownReport = await fetch(`${baseUrl}/datasets/${datasetId}/profile`, { headers: { cookie: owner.cookie } });
    expect(ownReport.status).toBe(200);
    expect((await ownReport.json()).profile.rowCount).toBe(1);
    const privateReport = await fetch(`${baseUrl}/datasets/${datasetId}/profile`, { headers: { cookie: other.cookie } });
    expect(privateReport.status).toBe(404);
  });

  it('previews, applies, undoes, and resets owner-scoped cleaning changes', async () => {
    const owner = await signUp('clean-owner@example.com');
    const other = await signUp('clean-other@example.com');
    const upload = await uploadCsv(owner.cookie, owner.csrf);
    const ticket = (await upload.json()).uploadToken as string;
    const imported = await jsonRequest('/datasets/import', { uploadToken: ticket }, owner.cookie, owner.csrf);
    const dataset = (await imported.json()).dataset;
    const operation = { action: 'trim_whitespace', column: 'region' };
    const previewResponse = await jsonRequest(`/datasets/${dataset.id}/clean/preview`, { operation }, owner.cookie, owner.csrf);
    expect(previewResponse.status).toBe(200);
    const cleanPreview = await previewResponse.json();
    expect(cleanPreview.contentBase64).toBeUndefined();
    const denied = await jsonRequest(`/datasets/${dataset.id}/clean/apply`, { operation, previewId: cleanPreview.previewId }, other.cookie, other.csrf);
    expect(denied.status).toBe(404);
    const applied = await jsonRequest(`/datasets/${dataset.id}/clean/apply`, { operation, previewId: cleanPreview.previewId }, owner.cookie, owner.csrf);
    expect(applied.status).toBe(200);
    expect(datasetStore.records[0]?.cleaningHistory).toHaveLength(1);
    expect(datasetStore.records[0]?.workingStorageName).toMatch(/^working-[\da-f-]+\.csv$/i);
    const undone = await jsonRequest(`/datasets/${dataset.id}/clean/undo`, {}, owner.cookie, owner.csrf);
    const undoneBody = await undone.json();
    expect({ status: undone.status, body: undoneBody }).toEqual({ status: 200, body: expect.objectContaining({ resetToOriginal: true }) });
    expect(datasetStore.records[0]?.workingStorageName).toBeUndefined();
    const previewAgain = await jsonRequest(`/datasets/${dataset.id}/clean/preview`, { operation }, owner.cookie, owner.csrf);
    const previewAgainBody = await previewAgain.json();
    const appliedAgain = await jsonRequest(`/datasets/${dataset.id}/clean/apply`, { operation, previewId: previewAgainBody.previewId }, owner.cookie, owner.csrf);
    expect(appliedAgain.status).toBe(200);
    const reset = await jsonRequest(`/datasets/${dataset.id}/clean/reset`, {}, owner.cookie, owner.csrf);
    expect((await reset.json()).resetToOriginal).toBe(true);
  });

  it('runs validated analytics only against the authenticated owner dataset', async () => {
    const owner = await signUp('analytics-owner@example.com');
    const other = await signUp('analytics-other@example.com');
    const upload = await uploadCsv(owner.cookie, owner.csrf);
    const ticket = (await upload.json()).uploadToken as string;
    const imported = await jsonRequest('/datasets/import', { uploadToken: ticket }, owner.cookie, owner.csrf);
    const datasetId = (await imported.json()).dataset.id as string;
    const plan = { operation: 'summary' };
    const result = await jsonRequest(`/datasets/${datasetId}/analyze`, plan, owner.cookie, owner.csrf);
    expect(result.status).toBe(200);
    expect((await result.json()).operation).toBe('summary');
    const unsupported = await jsonRequest(`/datasets/${datasetId}/analyze`, { operation: 'summary', expression: 'malicious()' }, owner.cookie, owner.csrf);
    expect(unsupported.status).toBe(400);
    const privateResult = await jsonRequest(`/datasets/${datasetId}/analyze`, plan, other.cookie, other.csrf);
    expect(privateResult.status).toBe(404);
  });

  it('grounds owner questions in validated plans, passes dashboard filters, and rejects unknown columns', async () => {
    const owner = await signUp('ask-owner@example.com');
    const other = await signUp('ask-other@example.com');
    const upload = await uploadCsv(owner.cookie, owner.csrf);
    const ticket = (await upload.json()).uploadToken as string;
    const imported = await jsonRequest('/datasets/import', { uploadToken: ticket }, owner.cookie, owner.csrf);
    const datasetId = (await imported.json()).dataset.id as string;
    const body = { question: 'Show total revenue by region', filters: [{ column: 'region', operator: 'eq', value: 'east' }] };
    const answer = await jsonRequest(`/datasets/${datasetId}/ask`, body, owner.cookie, owner.csrf);
    expect(answer.status).toBe(200);
    const result = await answer.json();
    expect(result.answer).toContain('east: 12');
    expect(result.columnsUsed).toEqual(['revenue', 'region']);
    expect(result.filters).toEqual(body.filters);
    expect(questionPlanner.calls[0]?.columns).toEqual(['region', 'revenue']);
    const forbidden = await jsonRequest(`/datasets/${datasetId}/ask`, body, other.cookie, other.csrf);
    expect(forbidden.status).toBe(404);

    questionPlanner.response = { supported: true, clarification: '', plan: { operation: 'group_by', groupBy: 'not-a-column', column: 'revenue', aggregation: 'sum' } };
    const invalidColumn = await jsonRequest(`/datasets/${datasetId}/ask`, body, owner.cookie, owner.csrf);
    expect(invalidColumn.status).toBe(400);

    questionPlanner.response = { supported: false, clarification: 'Try a category comparison.', plan: null };
    const unsupported = await jsonRequest(`/datasets/${datasetId}/ask`, { question: 'Predict next year sales' }, owner.cookie, owner.csrf);
    expect(unsupported.status).toBe(200);
    expect((await unsupported.json()).supported).toBe(false);
  });

  it('manages owner datasets, saved analyses, question history, and CSV exports', async () => {
    const owner = await signUp('manage-owner@example.com');
    const other = await signUp('manage-other@example.com');
    const upload = await uploadCsv(owner.cookie, owner.csrf);
    const ticket = (await upload.json()).uploadToken as string;
    const imported = await jsonRequest('/datasets/import', { uploadToken: ticket }, owner.cookie, owner.csrf);
    const dataset = (await imported.json()).dataset as { id: string };
    const id = dataset.id;
    const request = (pathname: string, method: string, body?: unknown, cookie = owner.cookie, csrf = owner.csrf) => fetch(`${baseUrl}${pathname}`, { method, headers: { origin: ORIGIN, cookie, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });

    const renamed = await request(`/datasets/${id}`, 'PATCH', { name: 'Renamed sales' });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).dataset.name).toBe('Renamed sales');
    const details = await fetch(`${baseUrl}/datasets/${id}`, { headers: { cookie: owner.cookie } });
    expect((await details.json()).dataset.sizeBytes).toBeGreaterThan(0);

    const saved = await request(`/datasets/${id}/saved-analyses`, 'POST', { name: 'Revenue by region', configuration: { chartType: 'bar', title: 'Revenue by region', dimension: 'region', metric: 'revenue', aggregation: 'sum' } });
    expect(saved.status).toBe(201);
    const savedId = (await saved.json()).savedAnalysis.id as string;
    expect((await (await fetch(`${baseUrl}/datasets/${id}/saved-analyses`, { headers: { cookie: owner.cookie } })).json()).savedAnalyses).toHaveLength(1);
    expect((await fetch(`${baseUrl}/datasets/${id}/saved-analyses`, { headers: { cookie: other.cookie } })).status).toBe(404);
    expect((await request(`/datasets/${id}/saved-analyses/${savedId}`, 'DELETE')).status).toBe(204);
    datasetStore.records[0]!.columns.push({ name: 'date', inferredType: 'date' });
    const savedTrend = await request(`/datasets/${id}/saved-analyses`, 'POST', { name: 'Monthly revenue', configuration: { chartType: 'trend', title: 'Monthly revenue', dimension: 'date', metric: 'revenue', aggregation: 'sum', granularity: 'monthly' } });
    expect(savedTrend.status).toBe(201);
    expect((await savedTrend.json()).savedAnalysis.configuration.granularity).toBe('monthly');
    const invalidScatter = await request(`/datasets/${id}/saved-analyses`, 'POST', { name: 'Invalid scatter', configuration: { chartType: 'scatter', title: 'Invalid scatter', dimension: 'region', metric: 'revenue', aggregation: 'count' } });
    expect(invalidScatter.status).toBe(400);
    datasetStore.records[0]!.columns.push({ name: 'cost', inferredType: 'decimal' });
    const savedScatter = await request(`/datasets/${id}/saved-analyses`, 'POST', { name: 'Revenue vs cost', configuration: { chartType: 'scatter', title: 'Revenue vs cost', dimension: 'revenue', metric: 'cost', aggregation: 'count' } });
    expect(savedScatter.status).toBe(201);

    await jsonRequest(`/datasets/${id}/ask`, { question: 'Show revenue by region' }, owner.cookie, owner.csrf);
    const questionsResponse = await fetch(`${baseUrl}/datasets/${id}/questions`, { headers: { cookie: owner.cookie } });
    const questions = (await questionsResponse.json()).questions as Array<{ id: string; question: string }>;
    expect(questions).toHaveLength(1);
    expect(questions[0]?.question).toBe('Show revenue by region');
    expect((await request(`/datasets/${id}/questions/${questions[0]!.id}`, 'DELETE')).status).toBe(204);
    expect((await request(`/datasets/${id}/questions`, 'DELETE')).status).toBe(204);

    const csv = await request(`/datasets/${id}/export`, 'POST', { plan: { operation: 'rows', filters: [{ column: 'region', operator: 'eq', value: 'east' }] } });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toContain('east,12');
    expect((await request(`/datasets/${id}/export`, 'POST', { plan: { operation: 'rows' } }, other.cookie, other.csrf)).status).toBe(404);

    const storageName = datasetStore.records[0]!.storageName;
    const deleted = await request(`/datasets/${id}`, 'DELETE');
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).storageCleanupComplete).toBe(true);
    await expect(readFile(path.join(storageRoot, 'datasets', storageName))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fetch(`${baseUrl}/datasets/${id}`, { headers: { cookie: owner.cookie } })).status).toBe(404);
  });

  it('lets an owner preview another worksheet and rejects a different user using their ticket', async () => {
    const owner = await signUp('owner@example.com');
    const other = await signUp('other@example.com');
    const form = new FormData();
    form.append('file', new Blob(['xlsx bytes'], { type: 'application/octet-stream' }), 'book.xlsx');
    const uploaded = await fetch(`${baseUrl}/datasets/preview`, {
      method: 'POST', headers: { origin: ORIGIN, cookie: owner.cookie, 'x-csrf-token': owner.csrf }, body: form,
    });
    const ticket = (await uploaded.json()).uploadToken as string;
    const sheet = await jsonRequest('/datasets/preview-sheet', { uploadToken: ticket, worksheet: 'Details' }, owner.cookie, owner.csrf);
    expect(sheet.status).toBe(200);
    expect((await sheet.json()).selectedSheet).toBe('Details');

    const forbiddenImport = await jsonRequest('/datasets/import', { uploadToken: ticket, worksheet: 'Details' }, other.cookie, other.csrf);
    expect(forbiddenImport.status).toBe(404);
    const imported = await jsonRequest('/datasets/import', { uploadToken: ticket, worksheet: 'Details' }, owner.cookie, owner.csrf);
    expect(imported.status).toBe(201);
    expect(datasetStore.records[0]?.worksheet).toBe('Details');
  });

  it('rejects unsupported file types and oversized uploads', async () => {
    const account = await signUp('owner@example.com');
    const unsupported = new FormData();
    unsupported.append('file', new Blob(['unsafe']), 'macro.xlsm');
    const unsupportedResponse = await fetch(`${baseUrl}/datasets/preview`, {
      method: 'POST', headers: { origin: ORIGIN, cookie: account.cookie, 'x-csrf-token': account.csrf }, body: unsupported,
    });
    expect(unsupportedResponse.status).toBe(415);

    const oversized = new FormData();
    oversized.append('file', new Blob(['x'.repeat(1025)], { type: 'text/csv' }), 'large.csv');
    const oversizedResponse = await fetch(`${baseUrl}/datasets/preview`, {
      method: 'POST', headers: { origin: ORIGIN, cookie: account.cookie, 'x-csrf-token': account.csrf }, body: oversized,
    });
    expect(oversizedResponse.status).toBe(413);
  });
});
