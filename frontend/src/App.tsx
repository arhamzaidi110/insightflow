import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? 'http://127.0.0.1:4000' : '');
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

interface User {
  id: string;
  email: string;
  createdAt: string;
}

interface DatasetColumn {
  name: string;
  inferredType: string;
}

interface DatasetPreview {
  uploadToken: string;
  originalName: string;
  sizeBytes: number;
  rowCount: number;
  columnCount: number;
  columns: DatasetColumn[];
  preview: Record<string, unknown>[];
  warnings: string[];
  sheets: string[];
  selectedSheet: string | null;
}

interface ImportedDataset {
  id: string;
  name: string;
  fileType: 'csv' | 'xlsx';
  rowCount: number;
  columnCount: number;
  worksheet?: string;
  columns?: DatasetColumn[];
  sizeBytes?: number;
  createdAt?: string;
  status?: 'ready' | 'modified';
}

interface SavedView { id: string; name: string; configuration: { chartType: 'bar' | 'line' | 'trend' | 'scatter'; title: string; dimension: string; metric?: string; aggregation: 'sum' | 'average' | 'count'; granularity?: 'daily' | 'monthly' | 'quarterly' | 'yearly'; filters?: Array<{ column: string; operator: string; value: string }> }; createdAt: string; }
interface QuestionHistoryEntry { id: string; question: string; planSummary: string; answer?: string; supported?: boolean; createdAt: string; }
interface AskResult { supported: boolean; answer?: string; clarification?: string; calculation?: Record<string, unknown>; columnsUsed?: string[]; planSummary?: string; filters?: Array<{ column: string; operator: string; value?: unknown }>; warnings?: string[]; dataset: { id: string; name: string }; }

type DashboardTab = 'overview' | 'ask' | 'clean';

function Dashboard({ dataset, csrfToken, onSelect, onDelete, activeTab }: { dataset: ImportedDataset; csrfToken: string; onSelect: (dataset: ImportedDataset) => void; onDelete: () => void; activeTab: DashboardTab }) {
  const [datasets, setDatasets] = useState<ImportedDataset[]>([]);
  const [summary, setSummary] = useState<{ rowCount: number; columns: Array<{ column: string; count: number; missingCount: number; distinctCount: number; inferredType: string; statistics?: { sum: number; mean: number } }> } | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [totalRows, setTotalRows] = useState(dataset.rowCount);
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState('');
  const [filterColumn, setFilterColumn] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const [chart, setChart] = useState<'bar' | 'line' | 'trend' | 'scatter'>('bar');
  const [granularity, setGranularity] = useState<'daily' | 'monthly' | 'quarterly' | 'yearly'>('monthly');
  const [dimension, setDimension] = useState(dataset.columns?.[0]?.name ?? '');
  const [metric, setMetric] = useState(dataset.columns?.find((column) => /number|integer|float|decimal/i.test(column.inferredType))?.name ?? '');
  const [aggregation, setAggregation] = useState<'sum' | 'average' | 'count'>('sum');
  const [saved, setSaved] = useState<SavedView[]>([]);
  const [questions, setQuestions] = useState<QuestionHistoryEntry[]>([]);
  const [openHistoryId, setOpenHistoryId] = useState('');
  const [savedSelection, setSavedSelection] = useState('');
  const [renameValue, setRenameValue] = useState(dataset.name);
  const [viewName, setViewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const [askResult, setAskResult] = useState<AskResult | null>(null);
  const [askError, setAskError] = useState('');
  const [asking, setAsking] = useState(false);
  const [askElapsedSeconds, setAskElapsedSeconds] = useState(0);
  const [lastQuestion, setLastQuestion] = useState('');
  const filter = useMemo(() => filterColumn && filterValue ? [{ column: filterColumn, operator: 'contains', value: filterValue }] : [], [filterColumn, filterValue]);
  const numericColumns = useMemo(() => dataset.columns?.filter((column) => /number|integer|float|decimal/i.test(column.inferredType)) ?? [], [dataset.columns]);
  const promptSuggestions = useMemo(() => {
    const dateColumn = dataset.columns?.find((column) => /date|datetime/i.test(column.inferredType));
    const categoryColumn = dataset.columns?.find((column) => !numericColumns.includes(column) && column !== dateColumn);
    const metricName = numericColumns[0]?.name;
    const metricLabel = metricName?.replaceAll('_', ' ');
    const groupColumn = (dateColumn ?? categoryColumn)?.name;
    const groupLabel = groupColumn?.replaceAll('_', ' ');
    const suggestions: string[] = [];
    if (metricName && groupColumn) {
      suggestions.push(`Which ${groupLabel} had the highest ${metricLabel}?`);
      suggestions.push(`Show the trend in ${metricLabel} by ${groupLabel}`);
    }
    if (metricName) suggestions.push(`What is the average ${metricLabel}?`);
    if (!suggestions.length && dataset.columns?.length) suggestions.push(`Summarize ${dataset.columns.slice(0, 2).map((column) => column.name.replaceAll('_', ' ')).join(' and ')}`);
    return [...new Set(suggestions)].slice(0, 3);
  }, [dataset.columns, numericColumns]);

  useEffect(() => {
    if (!asking) return;
    const timer = window.setInterval(() => setAskElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [asking]);

  useEffect(() => { void apiRequest<{ datasets: ImportedDataset[] }>('/datasets').then((result) => setDatasets(result.datasets)).catch(() => setDatasets([])); void apiRequest<{ savedAnalyses: SavedView[] }>(`/datasets/${encodeURIComponent(dataset.id)}/saved-analyses`).then((result) => setSaved(result.savedAnalyses)).catch(() => setSaved([])); void apiRequest<{ questions: QuestionHistoryEntry[] }>(`/datasets/${encodeURIComponent(dataset.id)}/questions`).then((result) => setQuestions(result.questions)).catch(() => setQuestions([])); }, [dataset.id]);
  useEffect(() => { setRenameValue(dataset.name); setDimension(dataset.columns?.[0]?.name ?? ''); setMetric(dataset.columns?.find((column) => /number|integer|float|decimal/i.test(column.inferredType))?.name ?? ''); setPage(1); setSavedSelection(''); }, [dataset.id, dataset.columns, dataset.name]);
  useEffect(() => {
    let cancelled = false;
    setBusy(true); setError('');
    const post = <T,>(plan: Record<string, unknown>) => apiRequest<T>(`/datasets/${encodeURIComponent(dataset.id)}/analyze`, { method: 'POST', body: JSON.stringify(plan) }, csrfToken);
    void Promise.all([
      post<typeof summary>({ operation: 'summary', filters: filter }),
      post<{ rows: Record<string, unknown>[]; totalRows: number }>({ operation: 'rows', page, pageSize: 20, ...(sortBy ? { column: sortBy, direction: 'asc' } : {}), filters: filter }),
    ]).then(([stats, table]) => { if (!cancelled) { setSummary(stats); setRows(table.rows); setTotalRows(table.totalRows); } }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Dashboard data could not be loaded.'); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [dataset.id, page, sortBy, filter, csrfToken]);

  const [groups, setGroups] = useState<Array<{ group: string | number | null; value: number | null }>>([]);
  const [trendPoints, setTrendPoints] = useState<Array<{ period: string; value: number | null }>>([]);
  const [scatterPoints, setScatterPoints] = useState<Array<{ x: number; y: number }>>([]);
  useEffect(() => { let cancelled = false; if (!dimension) return; const plan = chart === 'scatter' ? { operation: 'rows', columns: [dimension, metric], page: 1, pageSize: 100, filters: filter } : chart === 'trend' ? { operation: 'trend', dateColumn: dimension, granularity, ...(aggregation === 'count' || !metric ? {} : { column: metric }), aggregation: metric ? aggregation : 'count', filters: filter } : { operation: 'group_by', groupBy: dimension, ...(aggregation === 'count' || !metric ? {} : { column: metric }), aggregation: metric ? aggregation : 'count', limit: 12, filters: filter }; void apiRequest<{ groups?: Array<{ group: string | number | null; value: number | null }>; points?: Array<{ period: string; value: number | null }>; rows?: Record<string, unknown>[] }>(`/datasets/${encodeURIComponent(dataset.id)}/analyze`, { method: 'POST', body: JSON.stringify(plan) }, csrfToken).then((result) => { if (!cancelled) { setGroups(result.groups ?? []); setTrendPoints(result.points ?? []); setScatterPoints((result.rows ?? []).flatMap((row) => { const x = Number(row[dimension]); const y = Number(row[metric]); return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : []; })); } }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Chart could not be loaded.'); }); return () => { cancelled = true; }; }, [dataset.id, dimension, metric, aggregation, chart, granularity, filter, csrfToken]);

  async function saveView() { if (!viewName.trim()) return; try { const result = await apiRequest<{ savedAnalysis: SavedView }>(`/datasets/${encodeURIComponent(dataset.id)}/saved-analyses`, { method: 'POST', body: JSON.stringify({ name: viewName.trim(), configuration: { chartType: chart, title: viewName.trim(), dimension, ...(metric ? { metric } : {}), aggregation, ...(chart === 'trend' ? { granularity } : {}), filters: filter } }) }, csrfToken); setSaved((items) => [...items, result.savedAnalysis]); setSavedSelection(result.savedAnalysis.id); setViewName(''); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this analysis.'); } }
  async function downloadPlan(plan: Record<string, unknown>, suffix: string) { try { const response = await fetch(`${API_BASE}/datasets/${encodeURIComponent(dataset.id)}/export`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ plan }) }); if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error ?? body?.detail ?? 'CSV export failed.'); } const link = document.createElement('a'); const objectUrl = URL.createObjectURL(await response.blob()); link.href = objectUrl; link.download = `${dataset.name}-${suffix}.csv`; link.click(); URL.revokeObjectURL(objectUrl); } catch (cause) { setError(cause instanceof Error ? cause.message : 'CSV export failed.'); } }
  function exportCsv() { void downloadPlan({ operation: 'rows', columns: dataset.columns?.map((column) => column.name), filters: filter }, 'filtered-data'); }
  function exportChartCsv() { void downloadPlan(chart === 'scatter' ? { operation: 'rows', columns: [dimension, metric], page: 1, pageSize: 100, filters: filter } : chart === 'trend' ? { operation: 'trend', dateColumn: dimension, granularity, ...(metric && aggregation !== 'count' ? { column: metric } : {}), aggregation: metric ? aggregation : 'count', filters: filter } : { operation: 'group_by', groupBy: dimension, ...(metric && aggregation !== 'count' ? { column: metric } : {}), aggregation: metric ? aggregation : 'count', limit: 100, filters: filter }, chart === 'trend' ? 'trend' : chart === 'scatter' ? 'scatter' : 'aggregate'); }
  async function removeSavedView() { if (!savedSelection) return; try { await apiRequest<void>(`/datasets/${encodeURIComponent(dataset.id)}/saved-analyses/${encodeURIComponent(savedSelection)}`, { method: 'DELETE' }, csrfToken); setSaved((items) => items.filter((item) => item.id !== savedSelection)); setSavedSelection(''); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete this saved analysis.'); } }
  function openSavedView(id: string) { setSavedSelection(id); const view = saved.find((item) => item.id === id); if (!view) return; setChart(view.configuration.chartType); setDimension(view.configuration.dimension); setMetric(view.configuration.metric ?? ''); setAggregation(view.configuration.aggregation); setGranularity(view.configuration.granularity ?? 'monthly'); setViewName(view.configuration.title); }
  async function deleteQuestion(id: string) { try { await apiRequest<void>(`/datasets/${encodeURIComponent(dataset.id)}/questions/${encodeURIComponent(id)}`, { method: 'DELETE' }, csrfToken); setQuestions((items) => items.filter((item) => item.id !== id)); } catch (cause) { setAskError(cause instanceof Error ? cause.message : 'Could not remove question history.'); } }
  async function replayQuestion(item: QuestionHistoryEntry) { setQuestion(item.question); setAskElapsedSeconds(0); setAsking(true); setAskError(''); setAskResult(null); setOpenHistoryId(item.id); try { const result = await apiRequest<AskResult>(`/datasets/${encodeURIComponent(dataset.id)}/ask`, { method: 'POST', body: JSON.stringify({ question: item.question, filters: filter }) }, csrfToken); setAskResult(result); setLastQuestion(result.supported ? item.question : ''); const history = await apiRequest<{ questions: QuestionHistoryEntry[] }>(`/datasets/${encodeURIComponent(dataset.id)}/questions`); setQuestions(history.questions); } catch (cause) { setAskError(cause instanceof Error ? cause.message : 'The assistant could not answer this question.'); } finally { setAsking(false); } }
  async function clearQuestionHistory() { if (!window.confirm('Clear all saved question history for this dataset?')) return; try { await apiRequest<void>(`/datasets/${encodeURIComponent(dataset.id)}/questions`, { method: 'DELETE' }, csrfToken); setQuestions([]); } catch (cause) { setAskError(cause instanceof Error ? cause.message : 'Could not clear question history.'); } }
  async function renameDataset() { try { const result = await apiRequest<{ dataset: { id: string; name: string } }>(`/datasets/${encodeURIComponent(dataset.id)}`, { method: 'PATCH', body: JSON.stringify({ name: renameValue }) }, csrfToken); const renamed = { ...dataset, name: result.dataset.name }; onSelect(renamed); setDatasets((items) => items.map((item) => item.id === renamed.id ? renamed : item)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not rename the dataset.'); } }
  async function deleteDataset() { if (!window.confirm(`Delete ${dataset.name} and its uploaded data? This cannot be undone.`)) return; try { await apiRequest<{ storageCleanupComplete: boolean }>(`/datasets/${encodeURIComponent(dataset.id)}`, { method: 'DELETE' }, csrfToken); setDatasets((items) => items.filter((item) => item.id !== dataset.id)); onDelete(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete the dataset.'); } }
  async function askDataset(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setAskElapsedSeconds(0); setAsking(true); setAskError(''); setAskResult(null); try { const result = await apiRequest<AskResult>(`/datasets/${encodeURIComponent(dataset.id)}/ask`, { method: 'POST', body: JSON.stringify({ question, filters: filter, ...(lastQuestion && askResult?.supported ? { followUpContext: { question: lastQuestion, planSummary: askResult.planSummary ?? '' } } : {}) }) }, csrfToken); setAskResult(result); setLastQuestion(result.supported ? question : ''); const history = await apiRequest<{ questions: QuestionHistoryEntry[] }>(`/datasets/${encodeURIComponent(dataset.id)}/questions`); setQuestions(history.questions); } catch (cause) { setAskError(cause instanceof Error ? cause.message : 'The assistant could not answer this question.'); } finally { setAsking(false); } }

  return <section className={`dashboard-workspace dashboard-tab-${activeTab}`} aria-label="Dataset dashboard">
    <div className="dashboard-toolbar"><label>Active dataset <select aria-label="Active dataset" value={dataset.id} onChange={(event) => { const selected = datasets.find((item) => item.id === event.target.value); if (selected) onSelect(selected); }}>{datasets.length ? datasets.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.rowCount.toLocaleString()} rows × {item.columnCount} cols · {item.sizeBytes ? formatBytes(item.sizeBytes) : 'size n/a'} · {item.createdAt ? new Date(item.createdAt).toLocaleDateString() : 'date n/a'} · {item.status ?? 'ready'}</option>) : <option value={dataset.id}>{dataset.name}</option>}</select></label><span>{dataset.fileType.toUpperCase()} · {dataset.columns?.length ?? dataset.columnCount} columns</span></div>
    <div className="dataset-management"><label>Dataset name <input aria-label="Dataset name" value={renameValue} maxLength={120} onChange={(event) => setRenameValue(event.target.value)} /></label><button type="button" className="secondary-button" disabled={!renameValue.trim() || renameValue.trim() === dataset.name} onClick={() => void renameDataset()}>Rename dataset</button><button type="button" className="danger-button" onClick={() => void deleteDataset()}>Delete dataset</button><span>{dataset.sizeBytes ? formatBytes(dataset.sizeBytes) : 'Size unavailable'}{dataset.createdAt ? ` · imported ${new Date(dataset.createdAt).toLocaleDateString()}` : ''} · {dataset.status ?? 'ready'}</span></div>
    <div className="section-heading"><div><p className="eyebrow">OVERVIEW</p><strong>{dataset.name}</strong><p className="muted">Live metrics update with the filters below.</p></div></div>
    <div className="dashboard-filters"><label>Filter column <select aria-label="Filter column" value={filterColumn} onChange={(event) => { setFilterColumn(event.target.value); setPage(1); }}><option value="">No filter</option>{dataset.columns?.map((column) => <option key={column.name}>{column.name}</option>)}</select></label><label>Contains <input aria-label="Filter value" value={filterValue} onChange={(event) => { setFilterValue(event.target.value); setPage(1); }} placeholder="Filter rows" /></label></div>
    <section className="preview-card ask-workspace" aria-labelledby="ask-title"><p className="eyebrow">GROUNDED Q&amp;A</p><h3 id="ask-title">Ask about {dataset.name}</h3><p className="field-note">Gemini receives your question and column names/types. The calculation runs on this server; active filters are included.</p><div className="prompt-chips">{promptSuggestions.map((sample) => <button type="button" className="text-button" key={sample} onClick={() => setQuestion(sample)}>{sample}</button>)}</div><form className="ask-form" onSubmit={(event) => void askDataset(event)}><label htmlFor="dataset-question">Question</label><textarea id="dataset-question" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={500} minLength={3} required placeholder="Ask for a summary, comparison, ranking, trend, missing values, or duplicates" /><button className="primary-button" type="submit" disabled={asking || question.trim().length < 3}>{asking ? 'Calculating...' : 'Ask InsightFlow'}</button></form>{lastQuestion && <p className="field-note">Follow-up context uses only your last question and its validated calculation type. <button type="button" className="text-button" onClick={() => setLastQuestion('')}>Clear context</button></p>}{asking && <div className="ai-progress" role="status" aria-live="polite"><span className="ai-progress-spinner" aria-hidden="true" /><div className="ai-progress-copy"><strong>InsightFlow is working on your answer</strong><span>Elapsed <time>{Math.floor(askElapsedSeconds / 60)}:{String(askElapsedSeconds % 60).padStart(2, '0')}</time> - This can take up to 3 minutes.</span><div className="ai-progress-track" aria-hidden="true"><span /></div></div></div>}{askError && <p className="error-message" role="alert">{askError}</p>}{askResult && <div className="ask-answer" aria-live="polite"><p><strong>Dataset:</strong> {askResult.dataset.name}</p>{askResult.supported ? <><p className="answer-text">{askResult.answer}</p><p><strong>Calculation:</strong> {askResult.planSummary}</p><p><strong>Columns used:</strong> {askResult.columnsUsed?.join(', ') || 'None'}</p><p><strong>Filters:</strong> {askResult.filters?.length ? askResult.filters.map((item) => `${item.column} ${item.operator}${item.value === undefined ? '' : ` ${String(item.value)}`}`).join('; ') : 'None beyond the visible dashboard filter'}</p>{askResult.warnings?.map((warning) => <p className="field-note" key={warning}>{warning}</p>)}<details><summary>Show calculated source facts</summary><pre>{JSON.stringify(askResult.calculation, null, 2)}</pre></details><p className="field-note">This answer reports calculations from the selected data; it does not establish causation or predict future values.</p></> : <p>{askResult.clarification}</p>}</div>}</section>
    <section className="preview-card history-workspace" aria-labelledby="question-history-title"><div className="table-heading"><div><p className="eyebrow">RECENT QUESTIONS</p><h3 id="question-history-title">Question history</h3></div><button type="button" className="secondary-button" disabled={!questions.length} onClick={() => void clearQuestionHistory()}>Clear history</button></div>{questions.length ? <ul>{questions.map((item) => <li key={item.id}><span><strong>{item.question}</strong><small>{item.planSummary} · {new Date(item.createdAt).toLocaleString()}</small>{openHistoryId === item.id && item.answer && <span className="history-answer"><strong>{item.supported === false ? 'Response' : 'Answer'}</strong><span>{item.answer}</span></span>}</span><span className="history-actions">{item.answer ? <button type="button" className="text-button" aria-expanded={openHistoryId === item.id} onClick={() => setOpenHistoryId(openHistoryId === item.id ? '' : item.id)}>{openHistoryId === item.id ? 'Hide answer' : 'View answer'}</button> : <button type="button" className="text-button" disabled={asking} onClick={() => void replayQuestion(item)}>Generate &amp; save</button>}<button type="button" className="text-button" aria-label={`Delete question: ${item.question}`} onClick={() => void deleteQuestion(item.id)}>Delete</button></span></li>)}</ul> : <p className="muted">No saved questions yet. New answers will be saved here so you can open them again.</p>}</section>
    {error && <p className="error-message" role="alert">{error}</p>}{busy && <p role="status">Updating dashboard…</p>}
    <div className="stats-row dashboard-kpis"><div className="stat-card"><span>Filtered rows</span><strong>{(summary?.rowCount ?? dataset.rowCount).toLocaleString()}</strong></div><div className="stat-card"><span>Columns</span><strong>{dataset.columns?.length ?? dataset.columnCount}</strong></div><div className="stat-card"><span>Missing values</span><strong>{summary?.columns.reduce((sum, column) => sum + column.missingCount, 0).toLocaleString() ?? '—'}</strong></div><div className="stat-card"><span>Numeric columns</span><strong>{summary?.columns.filter((column) => column.inferredType === 'numeric').length ?? '—'}</strong></div></div>
    <section className="preview-card chart-builder"><div className="chart-controls"><label>Chart <select value={chart} onChange={(event) => { const next = event.target.value as typeof chart; setChart(next); if (next === 'trend' && !/date|datetime/i.test(dataset.columns?.find((column) => column.name === dimension)?.inferredType ?? '')) setDimension(dataset.columns?.find((column) => /date|datetime/i.test(column.inferredType))?.name ?? ''); if (next === 'scatter') { setDimension(numericColumns[0]?.name ?? ''); setMetric(numericColumns[1]?.name ?? numericColumns[0]?.name ?? ''); } }}><option value="bar">Category bar</option><option value="line">Category line</option><option value="trend" disabled={!dataset.columns?.some((column) => /date|datetime/i.test(column.inferredType))}>Time trend</option><option value="scatter" disabled={numericColumns.length < 2}>Scatter plot</option></select></label><label>{chart === 'trend' ? 'Date / X' : chart === 'scatter' ? 'Numeric X' : 'Category / X'} <select value={dimension} onChange={(event) => setDimension(event.target.value)}>{dataset.columns?.filter((column) => chart === 'trend' ? /date|datetime/i.test(column.inferredType) : chart === 'scatter' ? numericColumns.includes(column) : true).map((column) => <option key={column.name}>{column.name}</option>)}</select></label>{chart === 'trend' && <label>Time interval <select value={granularity} onChange={(event) => setGranularity(event.target.value as typeof granularity)}><option value="daily">Daily</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option></select></label>}<label>Numeric {chart === 'scatter' ? 'Y' : 'measure / Y'} <select value={metric} onChange={(event) => setMetric(event.target.value)}>{chart !== 'scatter' && <option value="">Count rows</option>}{numericColumns.map((column) => <option key={column.name}>{column.name}</option>)}</select></label>{chart !== 'scatter' && <label>Aggregate <select value={aggregation} onChange={(event) => setAggregation(event.target.value as typeof aggregation)}><option value="sum">Sum</option><option value="average">Average</option><option value="count">Count</option></select></label>}</div>
      {chart === 'scatter' ? <div className="scatter-chart" role="group" aria-labelledby="scatter-chart-title"><h3 id="scatter-chart-title">{metric} vs {dimension} · first {scatterPoints.length} filtered rows</h3>{scatterPoints.length ? <svg role="img" aria-label={`Scatter plot: ${scatterPoints.length} points, horizontal axis ${dimension}, vertical axis ${metric}`} viewBox="0 0 640 300" preserveAspectRatio="xMidYMid meet"><line x1="52" y1="250" x2="620" y2="250" /><line x1="52" y1="18" x2="52" y2="250" />{scatterPoints.map((point, index) => { const xs = scatterPoints.map((item) => item.x); const ys = scatterPoints.map((item) => item.y); const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys); const cx = 56 + ((point.x - minX) / (maxX - minX || 1)) * 556; const cy = 246 - ((point.y - minY) / (maxY - minY || 1)) * 220; return <circle key={index} cx={cx} cy={cy} r="4"><title>{dimension}: {point.x}, {metric}: {point.y}</title></circle>; })}<text x="320" y="286">{dimension}</text><text x="12" y="18">{metric}</text></svg> : <p className="muted">No numeric point pairs for these filters.</p>}{scatterPoints.length > 0 && <details><summary>View scatter data table</summary><div className="table-wrap" role="region" aria-label="Scatter chart data" tabIndex={0}><table><caption>First {scatterPoints.length} filtered points</caption><thead><tr><th scope="col">{dimension}</th><th scope="col">{metric}</th></tr></thead><tbody>{scatterPoints.map((point, index) => <tr key={index}><td>{point.x}</td><td>{point.y}</td></tr>)}</tbody></table></div></details>}</div> : (() => { const points = chart === 'trend' ? trendPoints.map((point) => ({ label: point.period, value: point.value })) : groups.map((point) => ({ label: String(point.group ?? '(empty)'), value: point.value })); const maximum = Math.max(1, ...points.map((point) => Number(point.value ?? 0))); return <div className="chart-frame" role="group" aria-labelledby="category-chart-title"><h3 id="category-chart-title">{metric ? `${aggregation} of ${metric}` : 'Row count'} by {dimension}{chart === 'trend' ? ` (${granularity})` : ''}</h3>{points.length ? <div className="bar-chart" role="region" aria-label="Scrollable chart values" tabIndex={0}>{points.map((point) => <div className="bar-item" key={point.label}><span className="bar-value">{point.value == null ? '—' : Number(point.value).toLocaleString()}</span><div className={`bar-fill ${chart !== 'bar' ? 'bar-fill-line' : ''}`} style={{ height: `${Math.max(5, (Number(point.value ?? 0) / maximum) * 160)}px` }} /><span className="bar-label">{point.label}</span></div>)}</div> : <p className="muted">No chart values for this filter.</p>}{points.length > 0 && <details><summary>View chart data table</summary><div className="table-wrap" role="region" aria-label="Chart data" tabIndex={0}><table><caption>Values for {dimension}</caption><thead><tr><th scope="col">{dimension}</th><th scope="col">{metric || 'Row count'}</th></tr></thead><tbody>{points.map((point) => <tr key={point.label}><th scope="row">{point.label}</th><td>{point.value ?? 'Not available'}</td></tr>)}</tbody></table></div></details>}</div>; })()}
      <div className="saved-view-controls"><input aria-label="Saved view name" value={viewName} onChange={(event) => setViewName(event.target.value)} placeholder="Name this chart" /><button type="button" className="secondary-button" disabled={!viewName.trim()} onClick={() => void saveView()}>Save chart</button><button type="button" className="secondary-button" onClick={exportChartCsv}>Export aggregate CSV</button><label>Open saved analysis <select aria-label="Open saved analysis" value={savedSelection} onChange={(event) => openSavedView(event.target.value)}><option value="">Choose saved analysis</option>{saved.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}</select></label><button type="button" className="danger-button" disabled={!savedSelection} onClick={() => void removeSavedView()}>Delete saved analysis</button></div>
    </section>
    <section className="preview-card"><div className="table-heading"><div><p className="eyebrow">DATA TABLE</p><h3>Filtered records</h3></div><button type="button" className="secondary-button" onClick={exportCsv}>Export filtered CSV</button></div><p className="field-note">Select a column heading to sort. Page {page} of {Math.max(1, Math.ceil(totalRows / 20))}; showing {rows.length} of {totalRows.toLocaleString()} filtered rows.</p><div className="table-wrap" role="region" aria-label="Filtered dataset table" tabIndex={0}><table><caption>Filtered dataset records, page {page}</caption><thead><tr>{dataset.columns?.map((column) => <th key={column.name} scope="col"><button type="button" className="table-sort" onClick={() => { setSortBy(column.name); setPage(1); }}>{column.name}{sortBy === column.name ? ' ↑' : ''}</button><small>{column.inferredType}</small></th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{dataset.columns?.map((column) => <td key={column.name}>{row[column.name] == null ? '—' : String(row[column.name])}</td>)}</tr>)}</tbody></table></div><div className="pagination"><button type="button" className="secondary-button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><span>Page {page}</span><button type="button" className="secondary-button" disabled={page * 20 >= totalRows} onClick={() => setPage((value) => value + 1)}>Next</button></div></section>
  </section>;
}

type CleanAction = 'trim_whitespace' | 'standardize_blanks' | 'remove_duplicates' | 'drop_columns' | 'rename_column' | 'convert_numeric' | 'convert_date' | 'fill_missing' | 'filter_rows';
interface CleanOperation { action: CleanAction; column?: string; columns?: string[]; newName?: string; method?: 'mean' | 'median' | 'mode' | 'constant'; value?: string | number; operator?: 'eq' | 'ne' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte'; coerceFailures?: boolean }
interface CleanPreview { before: { rowCount: number; columnCount: number }; after: { rowCount: number; columnCount: number }; affectedRows: number; affectedColumns: number; warnings: string[]; preview: Record<string, unknown>[]; columns: DatasetColumn[]; profile: QualityProfile; previewId: string; operation: CleanOperation }

interface QualityProfile { rowCount: number; columnCount: number; duplicateRowCount: number; warnings: string[]; columns: Array<{ name: string; inferredType: string; missingCount: number; missingPercent: number; nullCount: number; blankCount: number; distinctCount: number; severity: string; explanation: string; warnings: string[]; suggestions: string[]; numericStats?: Record<string, number | null>; dateStats?: Record<string, string | number>; topValues?: Array<{ value: string; count: number }> }> }

async function apiRequest<T>(
  pathname: string,
  options: RequestInit = {},
  csrfToken?: string,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers,
    credentials: 'include',
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error ?? body?.detail ?? 'The request could not be completed.';
    throw Object.assign(new Error(message), { status: response.status });
  }
  return body as T;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AuthPanel({ onAuthenticated }: { onAuthenticated: (user: User, csrfToken: string) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await apiRequest<{ user: User; csrfToken: string }>(`/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      onAuthenticated(result.user, result.csrfToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="eyebrow">INSIGHTFLOW</p>
        <h1 id="auth-title">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
        <p className="muted">Sign in to import and inspect your data securely.</p>
        <form className="auth-form" onSubmit={submit}>
          <label htmlFor="email">Email address</label>
          <input id="email" name="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'signup' ? 12 : 1} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} />
          {mode === 'signup' && <p className="field-note">Use at least 12 characters. Passwords are stored as one-way hashes.</p>}
          {error && <p className="error-message" role="alert">{error}</p>}
          <button className="primary-button full-width" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <p className="switch-mode">
          {mode === 'login' ? 'New to InsightFlow?' : 'Already have an account?'}{' '}
          <button className="text-button" type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); }}>
            {mode === 'login' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </section>
      <aside className="auth-aside">
        <p className="eyebrow">YOUR DATA, MADE CLEAR</p>
        <h2>Bring a spreadsheet. Start with the facts.</h2>
        <p>Preview the file, inspect its columns, and choose the worksheet before importing it into your workspace.</p>
        <div className="auth-visual">
          <img src="/assets/insightflow-login.png" alt="Soft blue charts and spreadsheet panels illustrating data analysis" />
        </div>
        <div className="aside-note"><span aria-hidden="true">✓</span> Original uploads stay private and unchanged.</div>
      </aside>
    </main>
  );
}

function UploadWorkspace({ csrfToken, user, onSignOut }: { csrfToken: string; user: User; onSignOut: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const requestController = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<DatasetPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'worksheet' | 'import' | null>(null);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [error, setError] = useState('');
  const [imported, setImported] = useState<ImportedDataset | null>(null);
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');
  const [savedDatasets, setSavedDatasets] = useState<ImportedDataset[]>([]);
  const [originalImported, setOriginalImported] = useState<ImportedDataset | null>(null);
  const [profile, setProfile] = useState<QualityProfile | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [cleanAction, setCleanAction] = useState<CleanAction>('trim_whitespace');
  const [cleanColumn, setCleanColumn] = useState('');
  const [cleanValue, setCleanValue] = useState('');
  const [cleanMethod, setCleanMethod] = useState<'mean' | 'median' | 'mode' | 'constant'>('mean');
  const [cleanOperator, setCleanOperator] = useState<'eq' | 'ne' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte'>('eq');
  const [coerceFailures, setCoerceFailures] = useState(false);
  const [cleanPreview, setCleanPreview] = useState<CleanPreview | null>(null);
  const [cleanHistory, setCleanHistory] = useState<Array<{ action: string; timestamp: string; affectedRows: number; affectedColumns: number; column?: string }>>([]);
  const [cleanBusy, setCleanBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => { void apiRequest<{ datasets: ImportedDataset[] }>('/datasets').then((result) => setSavedDatasets(result.datasets)).catch(() => undefined); }, []);

  function chooseFile(nextFile: File | undefined) {
    if (!nextFile) return;
    const validExtension = /\.(csv|xlsx)$/i.test(nextFile.name);
    if (!validExtension) {
      setError('Choose a CSV or XLSX file. Excel macro-enabled workbooks are not supported.');
      return;
    }
    if (nextFile.size === 0) {
      setError('This file is empty. Choose a file that contains data.');
      return;
    }
    if (nextFile.size > MAX_UPLOAD_BYTES) {
      setError('The file exceeds the 25 MB upload limit.');
      return;
    }
    setFile(nextFile);
    setPreview(null);
    setImported(null);
    setActiveTab('overview');
    setError('');
    setSelectedSheet('');
  }

  function cancelRequest() {
    requestController.current?.abort();
    requestController.current = null;
    setBusy(null);
  }

  async function inspectFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    const controller = new AbortController();
    requestController.current = controller;
    setBusy('preview');
    setError('');
    setPreview(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const result = await apiRequest<DatasetPreview>('/datasets/preview', {
        method: 'POST', body: form, signal: controller.signal,
      }, csrfToken);
      setPreview(result);
      setSelectedSheet(result.selectedSheet ?? result.sheets[0] ?? '');
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : 'Could not preview this file.');
    } finally {
      if (requestController.current === controller) requestController.current = null;
      setBusy(null);
    }
  }

  async function selectWorksheet(worksheet: string) {
    if (!preview || !worksheet) return;
    const controller = new AbortController();
    requestController.current = controller;
    setBusy('worksheet');
    setError('');
    try {
      const result = await apiRequest<DatasetPreview>('/datasets/preview-sheet', {
        method: 'POST',
        body: JSON.stringify({ uploadToken: preview.uploadToken, worksheet }),
        signal: controller.signal,
      }, csrfToken);
      setPreview({ ...preview, ...result });
      setSelectedSheet(worksheet);
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : 'Could not preview that worksheet.');
    } finally {
      if (requestController.current === controller) requestController.current = null;
      setBusy(null);
    }
  }

  async function importDataset() {
    if (!preview) return;
    const controller = new AbortController();
    requestController.current = controller;
    setBusy('import');
    setError('');
    try {
      const result = await apiRequest<{ dataset: ImportedDataset }>('/datasets/import', {
        method: 'POST',
        body: JSON.stringify({
          uploadToken: preview.uploadToken,
          ...(preview.sheets.length > 0 && selectedSheet ? { worksheet: selectedSheet } : {}),
        }),
        signal: controller.signal,
      }, csrfToken);
      setImported(result.dataset);
      setActiveTab('overview');
      setSavedDatasets((items) => [result.dataset, ...items.filter((item) => item.id !== result.dataset.id)]);
      setOriginalImported(result.dataset);
      setPreview(null);
      setFile(null);
      setSelectedSheet('');
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : 'Could not import this dataset.');
    } finally {
      if (requestController.current === controller) requestController.current = null;
      setBusy(null);
    }
  }

  function dropFile(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragging(false);
    chooseFile(event.dataTransfer.files[0]);
  }

  function reset() {
    cancelRequest();
    setFile(null);
    setPreview(null);
    setImported(null);
    setOriginalImported(null);
    setProfile(null);
    setCleanPreview(null);
    setCleanHistory([]);
    setError('');
    if (fileInput.current) fileInput.current.value = '';
  }

  function makeCleanOperation(): CleanOperation {
    if (cleanAction === 'drop_columns') return { action: cleanAction, columns: cleanValue.split(',').map((item) => item.trim()).filter(Boolean) };
    if (cleanAction === 'rename_column') return { action: cleanAction, column: cleanColumn, newName: cleanValue };
    if (cleanAction === 'convert_numeric' || cleanAction === 'convert_date') return { action: cleanAction, column: cleanColumn, coerceFailures };
    if (cleanAction === 'fill_missing') return { action: cleanAction, column: cleanColumn, method: cleanMethod, ...(cleanMethod === 'constant' ? { value: cleanValue } : {}) };
    if (cleanAction === 'filter_rows') return { action: cleanAction, column: cleanColumn, operator: cleanOperator, value: cleanValue };
    return { action: cleanAction, ...(cleanColumn ? { column: cleanColumn } : {}) };
  }

  async function requestClean(path: 'preview' | 'apply') {
    if (!imported) return;
    const operation = makeCleanOperation();
    setCleanBusy(true); setError('');
    try {
      const response = await apiRequest<CleanPreview & { history?: typeof cleanHistory }>(`/datasets/${encodeURIComponent(imported.id)}/clean/${path}`, { method: 'POST', body: JSON.stringify({ operation, ...(path === 'apply' && cleanPreview ? { previewId: cleanPreview.previewId } : {}) }) }, csrfToken);
      if (path === 'preview') setCleanPreview(response);
      else {
        setCleanPreview(null);
        if (response.history) setCleanHistory(response.history);
        setImported({ ...imported, rowCount: response.after.rowCount, columnCount: response.after.columnCount, columns: response.profile.columns.map(({ name, inferredType }) => ({ name, inferredType })) });
        setProfile(response.profile);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The cleaning operation failed.'); }
    finally { setCleanBusy(false); }
  }

  async function changeHistory(action: 'undo' | 'reset') {
    if (!imported) return;
    if (!window.confirm(action === 'undo' ? 'Undo the latest cleaning operation?' : 'Discard all cleaning changes and restore the original upload?')) return;
    setCleanBusy(true); setError('');
    try {
      const response = await apiRequest<{ history: typeof cleanHistory; resetToOriginal: boolean }>(`/datasets/${encodeURIComponent(imported.id)}/clean/${action}`, { method: 'POST', body: JSON.stringify({}) }, csrfToken);
      setCleanHistory(response.history);
      setCleanPreview(null);
      const report = await apiRequest<{ profile: QualityProfile }>(`/datasets/${encodeURIComponent(imported.id)}/profile`);
      setProfile(report.profile);
      const base = response.resetToOriginal || action === 'reset' ? originalImported ?? imported : imported;
      setImported({ ...base, rowCount: report.profile.rowCount, columnCount: report.profile.columnCount, columns: report.profile.columns.map(({ name, inferredType }) => ({ name, inferredType })) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update the cleaning history.'); }
    finally { setCleanBusy(false); }
  }

  return (
    <section className={`workspace${imported ? ' workspace-dashboard' : ''}`} aria-labelledby="upload-title">
      {!imported && <div className="section-heading">
        <div>
          <p className="eyebrow">DATASETS</p>
          <h1 id="upload-title">Import a data file</h1>
          <p className="muted">Start with a preview. Your original file is preserved as uploaded.</p>
        </div>
        <span className="privacy-pill"><span aria-hidden="true">●</span> Private workspace</span>
      </div>}

      {imported ? (
        <div className="dashboard-shell">
        <aside className="dashboard-sidebar" aria-label="Dashboard navigation">
          <div className="sidebar-brand"><span className="brand-mark" aria-hidden="true">I</span><span>InsightFlow</span></div>
          <p className="sidebar-section-label">WORKSPACE</p>
          <nav className="sidebar-nav" aria-label="Dataset sections">
            <button type="button" aria-current={activeTab === 'overview' ? 'page' : undefined} className={activeTab === 'overview' ? 'sidebar-link sidebar-link-active' : 'sidebar-link'} onClick={() => setActiveTab('overview')}><svg className="sidebar-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="5" height="5" rx="1"/><rect x="12" y="3" width="5" height="5" rx="1"/><rect x="3" y="12" width="5" height="5" rx="1"/><rect x="12" y="12" width="5" height="5" rx="1"/></svg>Overview</button>
            <button type="button" aria-current={activeTab === 'ask' ? 'page' : undefined} className={activeTab === 'ask' ? 'sidebar-link sidebar-link-active' : 'sidebar-link'} onClick={() => setActiveTab('ask')}><svg className="sidebar-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.5h14v9H9l-5 3v-3H3z"/><path d="M7 8h6M7 10.5h4"/></svg>Ask your data</button>
            <button type="button" aria-current={activeTab === 'clean' ? 'page' : undefined} className={activeTab === 'clean' ? 'sidebar-link sidebar-link-active' : 'sidebar-link'} onClick={() => setActiveTab('clean')}><svg className="sidebar-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m4 14 8-8 3 3-8 8H4z"/><path d="m10.5 7.5 3 3M13.5 4l2.5 2.5"/></svg>Clean data</button>
          </nav>
          <div className="sidebar-dataset"><span className="sidebar-dataset-dot" aria-hidden="true" /><div><small>ACTIVE DATASET</small><strong title={imported.name}>{imported.name}</strong><span>{imported.rowCount.toLocaleString()} rows · {imported.columnCount} columns</span></div></div>
          <div className="sidebar-private"><svg className="sidebar-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>Your workspace is private</div>
        </aside>
        <div className="dashboard-main">
        <header className="dashboard-header"><span className="dashboard-header-context">Dataset workspace</span><div className="dashboard-header-account"><span>{user.email}</span><button type="button" className="text-button" onClick={onSignOut}>Sign out</button></div></header>
        <div className="section-heading dashboard-page-heading">
          <div><p className="eyebrow">DATA WORKSPACE</p><h1 id="upload-title">{activeTab === 'overview' ? 'Overview' : activeTab === 'ask' ? 'Ask your data' : 'Clean your data'}</h1><p className="muted">{activeTab === 'overview' ? 'Explore metrics, charts, and records from your dataset.' : activeTab === 'ask' ? 'Get answers grounded in the data you uploaded.' : 'Preview and apply changes to a working copy.'}</p></div>
          <span className="privacy-pill"><span className="privacy-indicator" aria-hidden="true" /> Private workspace</span>
        </div>
        <section className="success-card" aria-live="polite">
          <div className="success-icon" aria-hidden="true">✓</div>
          <div>
            <p className="eyebrow">IMPORT COMPLETE</p>
            <h2>{imported.name}</h2>
            <p>{imported.rowCount.toLocaleString()} rows · {imported.columnCount} columns · {imported.fileType.toUpperCase()}{imported.worksheet ? ` · ${imported.worksheet}` : ''}</p>
          </div>
          <button type="button" className="primary-button" disabled={profileBusy} onClick={async () => {
            setProfileBusy(true); setError('');
            try { const result = await apiRequest<{ profile: QualityProfile }>(`/datasets/${encodeURIComponent(imported.id)}/profile`); setProfile(result.profile); setActiveTab('overview'); }
            catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not generate the data quality report.'); }
            finally { setProfileBusy(false); }
          }}>{profileBusy ? 'Analyzing…' : profile ? 'Refresh quality report' : 'Generate data quality report'}</button>
          <button type="button" className="secondary-button" onClick={reset}>Import another file</button>
        </section>
        <Dashboard dataset={imported} csrfToken={csrfToken} activeTab={activeTab} onSelect={(dataset) => { setImported(dataset); setActiveTab('overview'); setSavedDatasets((items) => items.map((item) => item.id === dataset.id ? dataset : item)); setProfile(null); setCleanPreview(null); }} onDelete={() => { setImported(null); setProfile(null); setCleanPreview(null); setSavedDatasets((items) => items.filter((item) => item.id !== imported.id)); }} />
        {activeTab === 'clean' && <section className="preview-card cleaning-workspace" aria-labelledby="cleaning-title">
          <p className="eyebrow">CLEANING WORKSPACE</p>
          <h2 id="cleaning-title">Preview a change before applying it</h2>
          <p className="muted">Changes are saved as a derived working copy. Your original uploaded file stays unchanged.</p>
          <div className="cleaning-controls">
            <label htmlFor="clean-action">Action</label>
            <select id="clean-action" value={cleanAction} onChange={(event) => { setCleanAction(event.target.value as CleanAction); setCleanPreview(null); }}>
              <option value="trim_whitespace">Trim whitespace</option><option value="standardize_blanks">Standardize blank strings as missing</option>
              <option value="remove_duplicates">Remove exact duplicate rows</option><option value="drop_columns">Drop selected columns</option>
              <option value="rename_column">Rename a column</option><option value="convert_numeric">Convert a column to numeric</option>
              <option value="convert_date">Convert a column to date</option><option value="fill_missing">Fill missing values</option><option value="filter_rows">Filter rows</option>
            </select>
            {!['trim_whitespace', 'standardize_blanks', 'remove_duplicates'].includes(cleanAction) && cleanAction !== 'drop_columns' && <>
              <label htmlFor="clean-column">Column</label>
              <select id="clean-column" value={cleanColumn} onChange={(event) => { setCleanColumn(event.target.value); setCleanPreview(null); }}>
                <option value="">Choose a column</option>{(imported.columns ?? []).map((column) => <option key={column.name} value={column.name}>{column.name} ({column.inferredType})</option>)}
              </select>
            </>}
            {cleanAction === 'drop_columns' && <><label htmlFor="drop-columns">Columns to drop (comma separated)</label><input id="drop-columns" value={cleanValue} onChange={(event) => setCleanValue(event.target.value)} placeholder="region, notes" /></>}
            {cleanAction === 'rename_column' && <><label htmlFor="new-column-name">New column name</label><input id="new-column-name" value={cleanValue} onChange={(event) => setCleanValue(event.target.value)} maxLength={120} /></>}
            {cleanAction === 'fill_missing' && <><label htmlFor="fill-method">Fill method</label><select id="fill-method" value={cleanMethod} onChange={(event) => setCleanMethod(event.target.value as typeof cleanMethod)}><option value="mean">Mean</option><option value="median">Median</option><option value="mode">Mode</option><option value="constant">Constant</option></select>{cleanMethod === 'constant' && <><label htmlFor="fill-value">Constant value</label><input id="fill-value" value={cleanValue} onChange={(event) => setCleanValue(event.target.value)} /></>}</>}
            {cleanAction === 'filter_rows' && <><label htmlFor="filter-operator">Condition</label><select id="filter-operator" value={cleanOperator} onChange={(event) => setCleanOperator(event.target.value as typeof cleanOperator)}><option value="eq">is equal to</option><option value="ne">is not equal to</option><option value="contains">contains text</option><option value="gt">greater than</option><option value="gte">at least</option><option value="lt">less than</option><option value="lte">at most</option></select><label htmlFor="filter-value">Value</label><input id="filter-value" value={cleanValue} onChange={(event) => setCleanValue(event.target.value)} /></>}
            {cleanAction.startsWith('convert_') && <label className="check-label"><input type="checkbox" checked={coerceFailures} onChange={(event) => setCoerceFailures(event.target.checked)} /> Replace failed conversions with missing values when applying</label>}
            <div className="upload-actions"><button type="button" className="secondary-button" disabled={cleanBusy} onClick={() => void requestClean('preview')}>{cleanBusy ? 'Working…' : 'Preview change'}</button>
              <button type="button" className="primary-button" disabled={!cleanPreview || JSON.stringify(cleanPreview.operation) !== JSON.stringify(makeCleanOperation()) || cleanBusy || (cleanAction.startsWith('convert_') && cleanPreview.warnings.length > 0 && !coerceFailures)} onClick={() => {
                if (['drop_columns', 'remove_duplicates', 'convert_numeric', 'convert_date', 'filter_rows'].includes(cleanAction) && !window.confirm('Apply this data change to the working copy? You can undo or reset it later.')) return;
                void requestClean('apply');
              }}>Apply to working copy</button></div>
          </div>
          {cleanPreview && <div className="warning-box" aria-live="polite"><strong>Impact preview</strong><p>Rows {cleanPreview.before.rowCount.toLocaleString()} → {cleanPreview.after.rowCount.toLocaleString()} · Columns {cleanPreview.before.columnCount} → {cleanPreview.after.columnCount} · Affected rows {cleanPreview.affectedRows} · affected columns {cleanPreview.affectedColumns}</p>
            {cleanPreview.warnings.map((warning) => <p key={warning}>{warning}</p>)}
            <div className="table-wrap" role="region" aria-label="Scrollable dataset table" tabIndex={0}><table><caption>First {cleanPreview.preview.length} rows after the proposed change</caption><thead><tr>{cleanPreview.columns.map((column) => <th key={column.name} scope="col">{column.name}<small>{column.inferredType}</small></th>)}</tr></thead><tbody>{cleanPreview.preview.map((row, index) => <tr key={index}>{cleanPreview.columns.map((column) => <td key={column.name}>{row[column.name] == null ? '—' : String(row[column.name])}</td>)}</tr>)}</tbody></table></div>
            <button type="button" className="text-button" onClick={() => { setProfile(cleanPreview.profile); }}>Review updated profile</button>
          </div>}
          {cleanHistory.length > 0 && <><h3>Cleaning history</h3><ol>{cleanHistory.map((item, index) => <li key={`${item.timestamp}-${index}`}>{item.action.replaceAll('_', ' ')}{item.column ? ` · ${item.column}` : ''} · {item.affectedRows} rows / {item.affectedColumns} columns affected</li>)}</ol>
            <button type="button" className="secondary-button" disabled={cleanBusy} onClick={() => void changeHistory('undo')}>Undo latest</button>{' '}<button type="button" className="secondary-button" disabled={cleanBusy} onClick={() => void changeHistory('reset')}>Reset to original</button></>}
        </section>}
        {error && <p className="error-message page-error" role="alert">{error}</p>}
        {profile && activeTab === 'overview' && <section className="preview-card quality-report" aria-labelledby="quality-title">
          <p className="eyebrow">DATA QUALITY</p><h2 id="quality-title">Quality report for {imported.name}</h2>
          <p>{profile.rowCount.toLocaleString()} rows · {profile.columnCount} columns · {profile.duplicateRowCount.toLocaleString()} duplicate rows</p>
          {profile.warnings.length > 0 && <div className="warning-box"><ul>{profile.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
          <div className="quality-columns">{profile.columns.map((column) => <article className="quality-column" key={column.name}>
            <div className="quality-column-heading"><h3>{column.name}</h3><span className={`severity severity-${column.severity}`}>{column.severity}</span></div>
            <p>{column.inferredType} · {column.distinctCount.toLocaleString()} distinct · {column.missingCount.toLocaleString()} missing ({column.missingPercent}%)</p>
            <p>{column.explanation}</p>
            {column.numericStats && <p>Min {column.numericStats.min} · Max {column.numericStats.max} · Mean {column.numericStats.mean} · Median {column.numericStats.median} · Sum {column.numericStats.sum} · Std dev {column.numericStats.standardDeviation ?? '—'}</p>}
            {column.dateStats && <p>Date coverage {column.dateStats.coveragePercent}% · {column.dateStats.min} to {column.dateStats.max}</p>}
            {column.topValues && <p>Common values: {column.topValues.map((item) => `${item.value} (${item.count})`).join(', ')}</p>}
            {column.suggestions.map((suggestion) => <p className="field-note" key={suggestion}>{suggestion}</p>)}
            {column.warnings.map((warning) => <p className="error-message" key={warning}>{warning}</p>)}
          </article>)}</div>
        </section>}
        </div>
        </div>
      ) : (
        <>
          {savedDatasets.length > 0 && <section className="preview-card dataset-library"><p className="eyebrow">YOUR DATASETS</p><h2>Continue where you left off</h2><div className="dataset-list">{savedDatasets.map((dataset) => <button type="button" className="dataset-choice" key={dataset.id} onClick={() => { setImported(dataset); setOriginalImported(dataset); setError(''); }}><strong>{dataset.name}</strong><span>{dataset.rowCount.toLocaleString()} rows · {dataset.columnCount} columns · {dataset.fileType.toUpperCase()}</span></button>)}</div></section>}
          <form className="upload-card" onSubmit={inspectFile}>
            <input
              ref={fileInput}
              className="visually-hidden"
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event: ChangeEvent<HTMLInputElement>) => chooseFile(event.target.files?.[0])}
              aria-label="Choose a CSV or XLSX file" aria-describedby="upload-hint"
            />
            <button
              className={`drop-zone${dragging ? ' drop-zone-active' : ''}`}
              type="button"
              onClick={() => fileInput.current?.click()}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
              onDrop={dropFile}
            >
              <span className="upload-icon" aria-hidden="true">↑</span>
              <span className="drop-title">{file ? file.name : 'Drop your file here, or browse'}</span>
              <span className="drop-hint" id="upload-hint">CSV or XLSX · up to 25 MB</span>
              {file && <span className="file-size">{formatBytes(file.size)}</span>}
            </button>
            <div className="upload-actions">
              <p className="field-note">Excel formulas are read as stored cell values; uploaded content is never executed.</p>
              {busy && <button type="button" className="text-button" onClick={cancelRequest}>Cancel</button>}
              <button className="primary-button" type="submit" disabled={!file || busy !== null}>
                {busy === 'preview' ? 'Preparing preview…' : 'Preview file'}
              </button>
            </div>
          </form>

          {error && <p className="error-message page-error" role="alert">{error}</p>}
          {busy && <p className="loading-message" role="status">{busy === 'worksheet' ? 'Loading worksheet preview…' : busy === 'import' ? 'Saving your dataset…' : 'Uploading and checking your file…'}</p>}

          {preview && (
            <section className="preview-card" aria-labelledby="preview-title">
              <div className="preview-heading">
                <div>
                  <p className="eyebrow">FILE PREVIEW</p>
                  <h2 id="preview-title">{preview.originalName}</h2>
                </div>
                <button type="button" className="secondary-button" onClick={reset}>Choose another file</button>
              </div>
              <div className="stats-row">
                <div className="stat-card"><span>Rows</span><strong>{preview.rowCount.toLocaleString()}</strong></div>
                <div className="stat-card"><span>Columns</span><strong>{preview.columnCount}</strong></div>
                <div className="stat-card"><span>File size</span><strong>{formatBytes(preview.sizeBytes)}</strong></div>
              </div>
              {preview.sheets.length > 1 && (
                <div className="sheet-picker">
                  <label htmlFor="worksheet">Worksheet</label>
                  <select id="worksheet" value={selectedSheet} onChange={(event) => void selectWorksheet(event.target.value)} disabled={busy !== null}>
                    {preview.sheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}
                  </select>
                </div>
              )}
              {preview.warnings.length > 0 && (
                <div className="warning-box" role="status">
                  <strong>Review these import notes</strong>
                  <ul>{preview.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>
                </div>
              )}
              <div className="table-wrap" role="region" aria-label="Scrollable dataset table" tabIndex={0}>
                <table>
                  <caption>First {preview.preview.length} rows from {preview.selectedSheet ?? preview.originalName}</caption>
                  <thead><tr>{preview.columns.map((column) => <th key={column.name} scope="col"><span>{column.name}</span><small>{column.inferredType}</small></th>)}</tr></thead>
                  <tbody>
                    {preview.preview.map((row, rowIndex) => (
                      <tr key={rowIndex}>{preview.columns.map((column) => <td key={column.name}>{row[column.name] == null ? <span className="empty-cell">—</span> : String(row[column.name])}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="preview-footer">
                <p>Check the columns and sample rows before saving this dataset.</p>
                <button type="button" className="primary-button" disabled={busy !== null} onClick={() => void importDataset()}>
                  {busy === 'import' ? 'Importing…' : 'Import dataset'}
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </section>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [csrfToken, setCsrfToken] = useState('');
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionError, setSessionError] = useState('');

  useEffect(() => {
    let active = true;
    async function restoreSession() {
      try {
        const current = await apiRequest<{ user: User }>('/auth/me');
        const csrf = await apiRequest<{ csrfToken: string }>('/auth/csrf');
        if (active) {
          setUser(current.user);
          setCsrfToken(csrf.csrfToken);
        }
      } catch (cause) {
        if (active && (cause as { status?: number }).status !== 401) {
          setSessionError(cause instanceof Error ? cause.message : 'Could not connect to the API.');
        }
      } finally {
        if (active) setCheckingSession(false);
      }
    }
    void restoreSession();
    return () => { active = false; };
  }, []);

  async function signOut() {
    try {
      await apiRequest('/auth/logout', { method: 'POST' }, csrfToken);
      setUser(null);
      setCsrfToken('');
    } catch (cause) {
      setSessionError(cause instanceof Error ? cause.message : 'Could not sign out.');
    }
  }

  if (checkingSession) {
    return <main className="loading-screen"><p className="eyebrow">INSIGHTFLOW</p><p role="status">Checking your session…</p></main>;
  }

  if (!user) {
    return <>
      {sessionError && <p className="connection-banner" role="alert">API connection: {sessionError}</p>}
      <AuthPanel onAuthenticated={(nextUser, nextCsrf) => { setUser(nextUser); setCsrfToken(nextCsrf); setSessionError(''); }} />
    </>;
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="InsightFlow home"><span className="brand-mark">I</span>InsightFlow</a>
        <nav aria-label="Main navigation"><a className="nav-active" href="#datasets">Datasets</a></nav>
        <div className="user-menu"><span className="user-email">{user.email}</span><button type="button" className="text-button" onClick={() => void signOut()}>Sign out</button></div>
      </header>
      {sessionError && <p className="connection-banner" role="alert">{sessionError}</p>}
      <main id="main-content"><div id="datasets"><UploadWorkspace csrfToken={csrfToken} user={user} onSignOut={() => void signOut()} /></div></main>
      <footer className="page-footer">InsightFlow · Your uploads remain private to your account.</footer>
    </div>
  );
}
