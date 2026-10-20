import mongoose, { type Model, type Types } from 'mongoose';

export interface StoredDataset {
  ownerId: Types.ObjectId;
  name: string;
  originalName: string;
  storageName: string;
  fileType: 'csv' | 'xlsx';
  sizeBytes: number;
  rowCount: number;
  columnCount: number;
  columns: { name: string; inferredType: string }[];
  worksheet?: string;
  workingStorageName?: string;
  cleaningHistory: { action: string; timestamp: Date; affectedRows: number; affectedColumns: number; column?: string; versionStorageName: string; previousStorageName?: string }[];
  savedAnalyses: { id: string; name: string; configuration: Record<string, unknown>; createdAt: Date }[];
  questionHistory: { id: string; question: string; planSummary: string; answer?: string; supported?: boolean; createdAt: Date }[];
  originalRowCount?: number;
  originalColumnCount?: number;
  originalColumns?: { name: string; inferredType: string }[];
  createdAt: Date;
}

const datasetSchema = new mongoose.Schema<StoredDataset>(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    originalName: { type: String, required: true, maxlength: 255 },
    storageName: { type: String, required: true, unique: true },
    fileType: { type: String, required: true, enum: ['csv', 'xlsx'] },
    sizeBytes: { type: Number, required: true, min: 1 },
    rowCount: { type: Number, required: true, min: 1 },
    columnCount: { type: Number, required: true, min: 1 },
    columns: {
      type: [{ name: { type: String, required: true }, inferredType: { type: String, required: true } }],
      required: true,
    },
    worksheet: { type: String, maxlength: 31 },
    workingStorageName: { type: String },
    originalRowCount: { type: Number }, originalColumnCount: { type: Number }, originalColumns: { type: [{ name: String, inferredType: String }] },
    cleaningHistory: { type: [{ action: { type: String, required: true }, timestamp: { type: Date, required: true }, affectedRows: { type: Number, required: true }, affectedColumns: { type: Number, required: true }, column: String, parameters: mongoose.Schema.Types.Mixed, beforeRowCount: Number, beforeColumnCount: Number, beforeColumns: [{ name: String, inferredType: String }], versionStorageName: { type: String, required: true }, previousStorageName: String }], default: [] },
    savedAnalyses: { type: [{ id: { type: String, required: true }, name: { type: String, required: true, maxlength: 80 }, configuration: { type: mongoose.Schema.Types.Mixed, required: true }, createdAt: { type: Date, required: true } }], default: [] },
    questionHistory: { type: [{ id: { type: String, required: true }, question: { type: String, required: true, maxlength: 500 }, planSummary: { type: String, required: true, maxlength: 300 }, answer: { type: String, maxlength: 4000 }, supported: Boolean, createdAt: { type: Date, required: true } }], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

datasetSchema.index({ ownerId: 1, createdAt: -1 });

export const DatasetModel =
  (mongoose.models.Dataset as Model<StoredDataset> | undefined) ?? mongoose.model<StoredDataset>('Dataset', datasetSchema);
