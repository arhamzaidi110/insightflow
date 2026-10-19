import { z } from 'zod';

export const analyticsPlanSchema = z.object({
  operation: z.enum(['summary', 'group_by', 'sort_top', 'trend', 'compare', 'missing', 'duplicates', 'correlation', 'rows']),
  column: z.string().max(120).optional(), groupBy: z.string().max(120).optional(), columns: z.array(z.string().max(120)).max(250).optional(),
  aggregation: z.enum(['sum', 'average', 'mean', 'count', 'min', 'max', 'median']).optional(), direction: z.enum(['asc', 'desc']).optional(), limit: z.number().int().min(1).max(100).optional(),
  dateColumn: z.string().max(120).optional(), granularity: z.enum(['daily', 'monthly', 'quarterly', 'yearly']).optional(), values: z.array(z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).max(2).optional(),
  filters: z.array(z.object({ column: z.string().max(120), operator: z.enum(['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte', 'in', 'is_null', 'not_null']), value: z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.union([z.string().max(500), z.number(), z.boolean()])).max(100), z.null()]).optional() }).strict()).max(20).optional(),
  page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(100).optional(),
}).strict();

export const questionSchema = z.object({ question: z.string().trim().min(3).max(500), filters: analyticsPlanSchema.shape.filters.optional(), followUpContext: z.object({ question: z.string().max(500), planSummary: z.string().max(300) }).strict().optional() }).strict();
