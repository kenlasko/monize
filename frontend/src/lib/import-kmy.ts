import { createBinaryImportClient } from './import-binary-client';
import type { BinaryImportClient } from './import-mny';

/**
 * Client for the KMyMoney (`.kmy`, or plain `.xml`) import endpoints
 * (`/import/kmy/parse|start|jobs/:id|staged/:id`). The shapes, the job and the
 * timeouts are the Money import's own (`createBinaryImportClient`); no password
 * is ever sent, because no KMyMoney file asks for one.
 */
export const kmyImportApi: BinaryImportClient =
  createBinaryImportClient('/import/kmy');
