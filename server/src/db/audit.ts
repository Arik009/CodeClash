import { type Db, type Document } from 'mongodb';

let auditDatabase: Db | null = null;

/** When set, audit rows live in a database the application user cannot update. */
export function setAuditDb(db: Db) {
  auditDatabase = db;
}

export function auditCollection(db: Db) {
  return (auditDatabase ?? db).collection<Document>('audit');
}
