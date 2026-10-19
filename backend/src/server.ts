import { app } from './app.js';
import { config } from './config.js';
import mongoose from 'mongoose';
import { SessionModel } from './models/session.js';
import { UserModel } from './models/user.js';
import { DatasetModel } from './models/dataset.js';
import path from 'node:path';
import { cleanupStaleTempFiles } from './datasets/routes.js';

async function start(): Promise<void> {
  if (!config.MONGODB_URI) {
    throw new Error('MONGODB_URI is required to start the API. Configure it in the root .env file.');
  }
  const storageRoot = path.resolve(config.UPLOAD_DIR);
  await cleanupStaleTempFiles(storageRoot);
  await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([UserModel.init(), SessionModel.init(), DatasetModel.init()]);
  const cleanupTimer = setInterval(() => {
    void cleanupStaleTempFiles(storageRoot).catch(() => {
      console.error(JSON.stringify({ event: 'upload_cleanup_failed' }));
    });
  }, 15 * 60 * 1000);
  cleanupTimer.unref();
  const port = Number(process.env.PORT) || config.BACKEND_PORT;
  app.listen(port, '0.0.0.0', () => {
    console.log(`InsightFlow backend listening on port ${port}`);
  });
}

start().catch((error: unknown) => {
  const missingUri = error instanceof Error && error.message.startsWith('MONGODB_URI is required');
  console.error(missingUri ? error.message : 'Could not connect to MongoDB. Check MONGODB_URI and database availability.');
  process.exitCode = 1;
});
