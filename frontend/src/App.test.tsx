import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('InsightFlow import experience', () => {
  it('shows the sign-in experience when no session exists', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Authentication required' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByLabelText('Email address')).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/auth/me',
      expect.objectContaining({ credentials: 'include' }),
    ));
  });

  it('previews a selected CSV before calling the import endpoint', async () => {
    const preview = {
      uploadToken: '7173ab70-4ef9-4713-9c86-36fc88fa3520',
      originalName: 'sales.csv',
      sizeBytes: 24,
      rowCount: 1,
      columnCount: 2,
      columns: [{ name: 'region', inferredType: 'string' }, { name: 'revenue', inferredType: 'integer' }],
      preview: [{ region: 'east', revenue: 12 }],
      warnings: [],
      sheets: [],
      selectedSheet: null,
    };
    const imported = { dataset: { id: 'dataset-1', name: 'sales', fileType: 'csv', rowCount: 1, columnCount: 2 } };
    const fetchMock = vi.fn().mockImplementation(async (input: string, options?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return { ok: true, status: 200, json: async () => ({ user: { id: 'user-1', email: 'person@example.com', createdAt: '' } }) };
      if (url.endsWith('/auth/csrf')) return { ok: true, status: 200, json: async () => ({ csrfToken: 'csrf-test-token' }) };
      if (url.endsWith('/datasets')) return { ok: true, status: 200, json: async () => ({ datasets: [] }) };
      if (url.endsWith('/datasets/dataset-1/analyze')) return { ok: true, status: 200, json: async () => options?.body && String(options.body).includes('"operation":"rows"') ? { rows: [], totalRows: 1 } : { rowCount: 1, columns: [] } };
      if (url.endsWith('/datasets/dataset-1/ask')) return { ok: true, status: 200, json: async () => ({ supported: true, answer: 'North has the highest sum of revenue: 12.', calculation: { groups: [{ group: 'North', value: 12 }] }, columnsUsed: ['region', 'revenue'], planSummary: 'group by · region', filters: [], warnings: [], dataset: { id: 'dataset-1', name: 'sales' } }) };
      if (url.endsWith('/datasets/preview')) return { ok: true, status: 200, json: async () => preview, options };
      if (url.endsWith('/datasets/import')) return { ok: true, status: 201, json: async () => imported, options };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Import a data file' })).toBeTruthy();
    const file = new File(['region,revenue\neast,12\n'], 'sales.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Choose a CSV or XLSX file'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview file' }));
    expect(await screen.findByRole('heading', { name: 'sales.csv' })).toBeTruthy();
    expect(screen.getByText('east')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Import dataset' }));
    expect(await screen.findByRole('heading', { name: 'sales' })).toBeTruthy();
    await waitFor(() => {
      const previewCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/datasets/preview'));
      expect(previewCall?.[1]?.credentials).toBe('include');
      expect((previewCall?.[1]?.headers as Headers).get('X-CSRF-Token')).toBe('csrf-test-token');
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/datasets/import'))).toBe(true);
    });
    await screen.findByRole('heading', { name: 'Ask about sales' });
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Show revenue by region' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask InsightFlow' }));
    expect(await screen.findByText('North has the highest sum of revenue: 12.')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).endsWith('/datasets/dataset-1/ask') && (options?.headers as Headers).get('X-CSRF-Token') === 'csrf-test-token')).toBe(true);
  });

  it('requires a cleaning preview before apply and shows operation history', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const profile = { rowCount: 1, columnCount: 2, duplicateRowCount: 0, warnings: [], columns: [] };
    const cleanPreview = { before: { rowCount: 1, columnCount: 2 }, after: { rowCount: 1, columnCount: 2 }, affectedRows: 0, affectedColumns: 0, warnings: [], preview: [{ region: 'east', revenue: 12 }], columns: [{ name: 'region', inferredType: 'string' }, { name: 'revenue', inferredType: 'integer' }], profile, previewId: '0717c42e-4f57-42a3-a911-2a3c451dfd2c', operation: { action: 'trim_whitespace' } };
    const fetchMock = vi.fn().mockImplementation(async (input: string, options?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return { ok: true, status: 200, json: async () => ({ user: { id: 'user-1', email: 'person@example.com', createdAt: '' } }) };
      if (url.endsWith('/auth/csrf')) return { ok: true, status: 200, json: async () => ({ csrfToken: 'csrf-test-token' }) };
      if (url.endsWith('/datasets')) return { ok: true, status: 200, json: async () => ({ datasets: [] }) };
      if (url.endsWith('/datasets/dataset-1/analyze')) return { ok: true, status: 200, json: async () => String(options?.body ?? '').includes('"operation":"rows"') ? { rows: [], totalRows: 1 } : { rowCount: 1, columns: [] } };
      if (url.endsWith('/datasets/preview')) return { ok: true, status: 200, json: async () => ({ uploadToken: '7173ab70-4ef9-4713-9c86-36fc88fa3520', originalName: 'sales.csv', sizeBytes: 24, rowCount: 1, columnCount: 2, columns: cleanPreview.columns, preview: cleanPreview.preview, warnings: [], sheets: [], selectedSheet: null }) };
      if (url.endsWith('/datasets/import')) return { ok: true, status: 201, json: async () => ({ dataset: { id: 'dataset-1', name: 'sales', fileType: 'csv', rowCount: 1, columnCount: 2, columns: cleanPreview.columns } }) };
      if (url.endsWith('/clean/preview')) return { ok: true, status: 200, json: async () => cleanPreview };
      if (url.endsWith('/clean/apply')) return { ok: true, status: 200, json: async () => ({ ...cleanPreview, history: [{ action: 'trim_whitespace', timestamp: new Date().toISOString(), affectedRows: 0, affectedColumns: 0 }] }) };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    await screen.findByRole('heading', { name: 'Import a data file' });
    const file = new File(['region,revenue\neast,12\n'], 'sales.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Choose a CSV or XLSX file'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview file' }));
    await screen.findByRole('heading', { name: 'sales.csv' });
    fireEvent.click(screen.getByRole('button', { name: 'Import dataset' }));
    await screen.findByRole('heading', { name: 'Preview a change before applying it' });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    await screen.findByText(/Impact preview/);
    fireEvent.click(screen.getByRole('button', { name: 'Apply to working copy' }));
    await screen.findByText(/Cleaning history/);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/datasets/dataset-1/clean/preview'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/datasets/dataset-1/clean/apply'))).toBe(true);
  });

  it('continues a saved dataset workflow through filtering, chart saving, history deletion, rename, and export', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:exported-csv') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const dataset = { id: 'dataset-existing', name: 'sales', fileType: 'csv', rowCount: 2, columnCount: 3, columns: [{ name: 'region', inferredType: 'string' }, { name: 'revenue', inferredType: 'integer' }, { name: 'cost', inferredType: 'decimal' }], sizeBytes: 64, createdAt: '2026-01-10T00:00:00.000Z', status: 'ready' };
    const savedAnalysis = { id: 'analysis-1', name: 'Revenue by region', configuration: { chartType: 'bar', title: 'Revenue by region', dimension: 'region', metric: 'revenue', aggregation: 'sum' }, createdAt: '2026-01-10T00:00:00.000Z' };
    const question = { id: 'question-1', question: 'Show revenue by region', planSummary: 'group by region', createdAt: '2026-01-10T00:00:00.000Z' };
    const fetchMock = vi.fn().mockImplementation(async (input: string, options?: RequestInit) => {
      const url = String(input);
      const body = typeof options?.body === 'string' ? JSON.parse(options.body) as Record<string, unknown> : {};
      if (url.endsWith('/auth/me')) return { ok: true, status: 200, json: async () => ({ user: { id: 'user-1', email: 'person@example.com', createdAt: '' } }) };
      if (url.endsWith('/auth/csrf')) return { ok: true, status: 200, json: async () => ({ csrfToken: 'csrf-test-token' }) };
      if (url.endsWith('/datasets')) return { ok: true, status: 200, json: async () => ({ datasets: [dataset] }) };
      if (url.endsWith('/datasets/dataset-existing/saved-analyses') && options?.method === 'POST') return { ok: true, status: 201, json: async () => ({ savedAnalysis: { ...savedAnalysis, id: 'analysis-2', name: body.name, configuration: body.configuration } }) };
      if (url.endsWith('/datasets/dataset-existing/saved-analyses')) return { ok: true, status: 200, json: async () => ({ savedAnalyses: [savedAnalysis] }) };
      if (url.endsWith('/datasets/dataset-existing/questions/question-1')) return { ok: true, status: 204, json: async () => null };
      if (url.endsWith('/datasets/dataset-existing/questions')) return { ok: true, status: 200, json: async () => ({ questions: [question] }) };
      if (url.endsWith('/datasets/dataset-existing') && options?.method === 'PATCH') return { ok: true, status: 200, json: async () => ({ dataset: { id: dataset.id, name: (body as { name: string }).name } }) };
      if (url.endsWith('/datasets/dataset-existing/analyze')) {
        if (body.operation === 'rows') return { ok: true, status: 200, json: async () => ({ rows: [{ region: 'east', revenue: 12, cost: 8 }], totalRows: 1 }) };
        if (body.operation === 'group_by') return { ok: true, status: 200, json: async () => ({ groups: [{ group: 'east', value: 12 }] }) };
        return { ok: true, status: 200, json: async () => ({ rowCount: 1, columns: [] }) };
      }
      if (url.endsWith('/datasets/dataset-existing/export')) return { ok: true, status: 200, blob: async () => new Blob(['region,revenue\neast,12\n'], { type: 'text/csv' }) };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /sales/ }));
    expect(await screen.findByRole('heading', { name: 'Ask about sales' })).toBeTruthy();
    expect(await screen.findByText('Show revenue by region')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Filter column'), { target: { value: 'region' } });
    fireEvent.change(screen.getByLabelText('Filter value'), { target: { value: 'east' } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, options]) => String(url).endsWith('/datasets/dataset-existing/analyze') && String(options?.body).includes('"value":"east"'))).toBe(true));
    expect(screen.getAllByText('east').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText('Saved view name'), { target: { value: 'East revenue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save chart' }));
    expect(await screen.findByRole('option', { name: 'East revenue' })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).endsWith('/datasets/dataset-existing/saved-analyses') && options?.method === 'POST')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Delete question: Show revenue by region/ }));
    await waitFor(() => expect(screen.queryByText('Show revenue by region')).toBeNull());
    fireEvent.change(screen.getByLabelText('Dataset name'), { target: { value: 'sales-renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename dataset' }));
    await waitFor(() => expect(screen.getAllByText('sales-renamed').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Export filtered CSV' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, options]) => String(url).endsWith('/datasets/dataset-existing/export') && options?.method === 'POST')).toBe(true));
    const exportRequest = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/datasets/dataset-existing/export'));
    expect(String(exportRequest?.[1]?.body)).toContain('"value":"east"');
    expect((exportRequest?.[1]?.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-test-token');
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
  });
});
