import { DatasetModel } from '../models/dataset.js';

export interface DatasetColumn {
  name: string;
  inferredType: string;
}

export interface NewDataset {
  ownerId: string;
  name: string;
  originalName: string;
  storageName: string;
  fileType: 'csv' | 'xlsx';
  sizeBytes: number;
  rowCount: number;
  columnCount: number;
  columns: DatasetColumn[];
  worksheet?: string;
  originalRowCount?: number;
  originalColumnCount?: number;
  originalColumns?: DatasetColumn[];
}

export interface DatasetRecord extends NewDataset {
  id: string;
  createdAt: Date;
  workingStorageName?: string;
  savedAnalyses: { id: string; name: string; configuration: Record<string, unknown>; createdAt: Date }[];
  questionHistory: { id: string; question: string; planSummary: string; createdAt: Date }[];
  cleaningHistory: { action: string; timestamp: Date; affectedRows: number; affectedColumns: number; column?: string; parameters?: Record<string, unknown>; beforeRowCount: number; beforeColumnCount: number; beforeColumns: DatasetColumn[]; versionStorageName: string; previousStorageName?: string }[];
}

export interface DatasetStore {
  create(dataset: NewDataset): Promise<DatasetRecord>;
  listForOwner(ownerId: string): Promise<DatasetRecord[]>;
  findByIdForOwner(id: string, ownerId: string): Promise<DatasetRecord | null>;
  updateForOwner(id: string, ownerId: string, update: Partial<Pick<DatasetRecord, 'name' | 'cleaningHistory' | 'rowCount' | 'columnCount' | 'columns' | 'savedAnalyses' | 'questionHistory'>> & { workingStorageName?: string | null }): Promise<DatasetRecord | null>;
  deleteForOwner(id: string, ownerId: string): Promise<DatasetRecord | null>;
}

export class MongoDatasetStore implements DatasetStore {
  async create(dataset: NewDataset): Promise<DatasetRecord> {
    const created = await DatasetModel.create(dataset);
    return {
      ...dataset,
      cleaningHistory: [],
      savedAnalyses: [], questionHistory: [],
      id: created._id.toString(),
      createdAt: created.createdAt,
    };
  }

  async findByIdForOwner(id: string, ownerId: string): Promise<DatasetRecord | null> {
    const { Types } = await import('mongoose');
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(ownerId)) return null;
    const found = await DatasetModel.findOne({ _id: new Types.ObjectId(id), ownerId: new Types.ObjectId(ownerId) }).lean();
    if (!found) return null;
    return { ...found, id: found._id.toString(), ownerId: found.ownerId.toString(), savedAnalyses: found.savedAnalyses ?? [], questionHistory: found.questionHistory ?? [] } as unknown as DatasetRecord;
  }

  async listForOwner(ownerId: string): Promise<DatasetRecord[]> {
    const { Types } = await import('mongoose');
    if (!Types.ObjectId.isValid(ownerId)) return [];
    const found = await DatasetModel.find({ ownerId: new Types.ObjectId(ownerId) }).sort({ createdAt: -1 }).select('_id ownerId name originalName storageName fileType sizeBytes rowCount columnCount columns worksheet createdAt workingStorageName').lean();
    return found.map((item) => ({ ...item, id: item._id.toString(), ownerId: item.ownerId.toString(), cleaningHistory: [], savedAnalyses: [], questionHistory: [] }) as unknown as DatasetRecord);
  }

  async updateForOwner(id: string, ownerId: string, update: Partial<Pick<DatasetRecord, 'name' | 'cleaningHistory' | 'rowCount' | 'columnCount' | 'columns' | 'savedAnalyses' | 'questionHistory'>> & { workingStorageName?: string | null }): Promise<DatasetRecord | null> {
    const { Types } = await import('mongoose');
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(ownerId)) return null;
    const { workingStorageName, ...setValues } = update;
    const updateDoc = { $set: { ...setValues, ...(workingStorageName ? { workingStorageName } : {}) }, ...(workingStorageName === null ? { $unset: { workingStorageName: 1 } } : {}) };
    const found = await DatasetModel.findOneAndUpdate({ _id: new Types.ObjectId(id), ownerId: new Types.ObjectId(ownerId) }, updateDoc, { new: true }).lean();
    if (!found) return null;
    return { ...found, id: found._id.toString(), ownerId: found.ownerId.toString(), savedAnalyses: found.savedAnalyses ?? [], questionHistory: found.questionHistory ?? [] } as unknown as DatasetRecord;
  }

  async deleteForOwner(id: string, ownerId: string): Promise<DatasetRecord | null> {
    const { Types } = await import('mongoose');
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(ownerId)) return null;
    const found = await DatasetModel.findOneAndDelete({ _id: new Types.ObjectId(id), ownerId: new Types.ObjectId(ownerId) }).lean();
    if (!found) return null;
    return { ...found, id: found._id.toString(), ownerId: found.ownerId.toString() } as unknown as DatasetRecord;
  }
}
