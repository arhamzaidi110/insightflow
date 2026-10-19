import { readFile } from 'node:fs/promises';
import type { DatasetColumn } from './dataset-store.js';

export interface DatasetPreview {
  rowCount: number;
  columnCount: number;
  columns: DatasetColumn[];
  preview: Record<string, unknown>[];
  warnings: string[];
  sheets: string[];
  selectedSheet: string | null;
  profile: DataQualityProfile;
}

export interface DataQualityProfile { rowCount: number; columnCount: number; duplicateRowCount: number; warnings: string[]; columns: Array<{ name: string; inferredType: string; missingCount: number; missingPercent: number; nullCount: number; blankCount: number; distinctCount: number; severity: string; explanation: string; warnings: string[]; suggestions: string[]; numericStats?: Record<string, number | null>; dateStats?: Record<string, string | number>; topValues?: Array<{ value: string; count: number }> }> }

export interface AnalyticsPlan { operation: 'summary' | 'group_by' | 'sort_top' | 'trend' | 'compare' | 'missing' | 'duplicates' | 'correlation' | 'rows'; column?: string; groupBy?: string; columns?: string[]; aggregation?: 'sum' | 'average' | 'mean' | 'count' | 'min' | 'max' | 'median'; direction?: 'asc' | 'desc'; limit?: number; dateColumn?: string; granularity?: 'daily' | 'monthly' | 'quarterly' | 'yearly'; values?: Array<string | number | boolean | null>; filters?: Array<{ column: string; operator: 'eq' | 'ne' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'is_null' | 'not_null'; value?: string | number | boolean | Array<string | number | boolean> }>; page?: number; pageSize?: number }

export interface AnalysisClient {
  preview(filePath: string, filename: string, worksheet?: string): Promise<DatasetPreview>;
  profile(filePath: string, filename: string, worksheet?: string): Promise<DataQualityProfile>;
  clean(filePath: string, filename: string, operation: Record<string, unknown>, worksheet?: string, apply?: boolean): Promise<CleanResult>;
  analyze(filePath: string, filename: string, plan: AnalyticsPlan, worksheet?: string): Promise<Record<string, unknown>>;
  exportCsv(filePath: string, filename: string, plan: AnalyticsPlan, worksheet?: string): Promise<Buffer>;
}

export interface CleanResult { before: { rowCount: number; columnCount: number }; after: { rowCount: number; columnCount: number }; affectedRows: number; affectedColumns: number; warnings: string[]; preview: Record<string, unknown>[]; columns: DatasetColumn[]; profile: DataQualityProfile; contentBase64: string }

export class AnalysisServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = 'AnalysisServiceError';
  }
}

export class HttpAnalysisClient implements AnalysisClient {
  constructor(private readonly baseUrl: string, private readonly serviceToken?: string) {}

  private get requestHeaders(): Record<string, string> | undefined {
    return this.serviceToken ? { 'X-Analysis-Token': this.serviceToken } : undefined;
  }

  async preview(filePath: string, filename: string, worksheet?: string): Promise<DatasetPreview> {
    const bytes = await readFile(filePath);
    const form = new FormData();
    form.append('file', new Blob([bytes]), filename);
    if (worksheet) form.append('sheet_name', worksheet);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/preview`, {
        method: 'POST',
        body: form,
        headers: this.requestHeaders,
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new AnalysisServiceError(503, 'The analysis service is unavailable. Try again shortly.');
    }

    const body = await response.json().catch(() => null) as { detail?: unknown } | null;
    if (!response.ok) {
      const detail = typeof body?.detail === 'string' ? body.detail : 'The file could not be analyzed.';
      throw new AnalysisServiceError(response.status >= 500 ? 503 : response.status, detail);
    }
    return body as DatasetPreview;
  }

  async profile(filePath: string, filename: string, worksheet?: string): Promise<DataQualityProfile> {
    return (await this.preview(filePath, filename, worksheet)).profile;
  }

  async clean(filePath: string, filename: string, operation: Record<string, unknown>, worksheet?: string, apply = false): Promise<CleanResult> {
    const bytes = await readFile(filePath);
    const form = new FormData();
    form.append('file', new Blob([bytes]), filename);
    form.append('operation', JSON.stringify(operation));
    form.append('apply', String(apply));
    if (worksheet) form.append('sheet_name', worksheet);
    let response: Response;
    try { response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/clean`, { method: 'POST', body: form, headers: this.requestHeaders, signal: AbortSignal.timeout(120_000) }); }
    catch { throw new AnalysisServiceError(503, 'The analysis service is unavailable. Try again shortly.'); }
    const body = await response.json().catch(() => null) as { detail?: unknown } | null;
    if (!response.ok) throw new AnalysisServiceError(response.status >= 500 ? 503 : response.status, typeof body?.detail === 'string' ? body.detail : 'The data could not be cleaned.');
    return body as CleanResult;
  }

  async analyze(filePath: string, filename: string, plan: AnalyticsPlan, worksheet?: string): Promise<Record<string, unknown>> {
    const bytes = await readFile(filePath);
    const form = new FormData();
    form.append('file', new Blob([bytes]), filename);
    form.append('plan', JSON.stringify(plan));
    if (worksheet) form.append('sheet_name', worksheet);
    let response: Response;
    try { response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/analyze`, { method: 'POST', body: form, headers: this.requestHeaders, signal: AbortSignal.timeout(120_000) }); }
    catch { throw new AnalysisServiceError(503, 'The analysis service is unavailable. Try again shortly.'); }
    const body = await response.json().catch(() => null) as { detail?: unknown } | null;
    if (!response.ok) throw new AnalysisServiceError(response.status >= 500 ? 503 : response.status, typeof body?.detail === 'string' ? body.detail : 'The analysis plan could not be run.');
    return body as Record<string, unknown>;
  }

  async exportCsv(filePath: string, filename: string, plan: AnalyticsPlan, worksheet?: string): Promise<Buffer> {
    const bytes = await readFile(filePath);
    const form = new FormData();
    form.append('file', new Blob([bytes]), filename);
    form.append('plan', JSON.stringify(plan));
    if (worksheet) form.append('sheet_name', worksheet);
    let response: Response;
    try { response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/export`, { method: 'POST', body: form, headers: this.requestHeaders, signal: AbortSignal.timeout(120_000) }); }
    catch { throw new AnalysisServiceError(503, 'The analysis service is unavailable. Try again shortly.'); }
    const body = await response.json().catch(() => null) as { detail?: unknown; contentBase64?: unknown } | null;
    if (!response.ok) throw new AnalysisServiceError(response.status >= 500 ? 503 : response.status, typeof body?.detail === 'string' ? body.detail : 'The CSV export could not be created.');
    if (typeof body?.contentBase64 !== 'string' || body.contentBase64.length > 14_000_000) throw new AnalysisServiceError(502, 'The analysis service returned an invalid CSV export.');
    return Buffer.from(body.contentBase64, 'base64');
  }
}
