const Datastore = require('nedb-promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const DB_DIR = process.env.DB_DIR || path.join(__dirname, '../data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const usersDb = Datastore.create({ filename: path.join(DB_DIR, 'users.db'), autoload: true });
const docsDb = Datastore.create({ filename: path.join(DB_DIR, 'documents.db'), autoload: true });
const sharesDb = Datastore.create({ filename: path.join(DB_DIR, 'shares.db'), autoload: true });

usersDb.ensureIndex({ fieldName: 'username', unique: true }).catch(() => {});

function now() { return new Date().toISOString(); }

// ─── Seed ─────────────────────────────────────────────────────────────────────

let seeded = false;
async function seedIfNeeded() {
  if (seeded) return;
  seeded = true;
  const count = await usersDb.count({});
  if (count > 0) return;

  await usersDb.insert([
    { _id: 'user-alice', username: 'alice', display_name: 'Alice Chen', avatar_color: '#6366f1', created_at: now() },
    { _id: 'user-bob', username: 'bob', display_name: 'Bob Martinez', avatar_color: '#f59e0b', created_at: now() },
    { _id: 'user-carol', username: 'carol', display_name: 'Carol Wu', avatar_color: '#10b981', created_at: now() },
  ]);

  const welcomeContent = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Welcome to DocFlow ✨' }] },
      { type: 'paragraph', content: [
        { type: 'text', text: 'This is a ' },
        { type: 'text', marks: [{ type: 'bold' }], text: 'lightweight collaborative document editor' },
        { type: 'text', text: ". Here's what you can do:" },
      ]},
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Create and edit rich-text documents' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Upload .txt, .md, or .docx files' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Share documents with other users by username' }] }] },
      ]},
      { type: 'paragraph', content: [
        { type: 'text', text: 'Try switching users (top-left dropdown) to see the sharing flow in action.' },
      ]},
    ],
  });

  await docsDb.insert({
    _id: 'doc-welcome',
    title: 'Welcome to DocFlow',
    content: welcomeContent,
    owner_id: 'user-alice',
    created_at: now(),
    updated_at: now(),
  });
}

seedIfNeeded().catch(console.error);

// ─── Users ────────────────────────────────────────────────────────────────────

async function getAllUsers() { return usersDb.find({}); }
async function getUserById(id) { return usersDb.findOne({ _id: id }); }
async function getUserByUsername(username) { return usersDb.findOne({ username }); }

// ─── Documents ────────────────────────────────────────────────────────────────

async function getDocumentsByUser(userId) {
  await seedIfNeeded();
  const owned = await docsDb.find({ owner_id: userId }).sort({ updated_at: -1 });
  const shareRecords = await sharesDb.find({ shared_with_id: userId });
  const docIds = shareRecords.map(s => s.document_id);

  let shared = [];
  if (docIds.length) {
    const docs = await docsDb.find({ _id: { $in: docIds } });
    shared = await Promise.all(docs.map(async d => {
      const owner = await usersDb.findOne({ _id: d.owner_id });
      const shareRec = shareRecords.find(s => s.document_id === d._id);
      return { ...d, id: d._id, owner_name: owner?.display_name, owner_color: owner?.avatar_color, permission: shareRec?.permission, relationship: 'shared' };
    }));
  }

  return {
    owned: owned.map(d => ({ ...d, id: d._id, relationship: 'owner' })),
    shared,
  };
}

async function getDocumentById(id) {
  const doc = await docsDb.findOne({ _id: id });
  if (!doc) return null;
  const owner = await usersDb.findOne({ _id: doc.owner_id });
  const shareRecords = await sharesDb.find({ document_id: id });
  const sharesWithUsers = await Promise.all(shareRecords.map(async s => {
    const u = await usersDb.findOne({ _id: s.shared_with_id });
    return { ...s, id: s._id, display_name: u?.display_name, username: u?.username, avatar_color: u?.avatar_color };
  }));
  return { ...doc, id: doc._id, owner_name: owner?.display_name, owner_color: owner?.avatar_color, shares: sharesWithUsers };
}

async function createDocument({ title, content, ownerId }) {
  const id = 'doc-' + uuidv4();
  const ts = now();
  const doc = { _id: id, title: title || 'Untitled Document', content: content || '', owner_id: ownerId, created_at: ts, updated_at: ts };
  await docsDb.insert(doc);
  return docsDb.findOne({ _id: id });
}

async function updateDocument(id, { title, content }) {
  const update = { updated_at: now() };
  if (title !== undefined) update.title = title;
  if (content !== undefined) update.content = content;
  await docsDb.update({ _id: id }, { $set: update });
  return docsDb.findOne({ _id: id });
}

async function deleteDocument(id) {
  await sharesDb.remove({ document_id: id }, { multi: true });
  return docsDb.remove({ _id: id });
}

// ─── Shares ───────────────────────────────────────────────────────────────────

async function shareDocument({ documentId, sharedWithId, permission }) {
  const existing = await sharesDb.findOne({ document_id: documentId, shared_with_id: sharedWithId });
  if (existing) {
    await sharesDb.update({ _id: existing._id }, { $set: { permission } });
    return sharesDb.findOne({ _id: existing._id });
  }
  const id = 'share-' + uuidv4();
  await sharesDb.insert({ _id: id, document_id: documentId, shared_with_id: sharedWithId, permission, shared_at: now() });
  return sharesDb.findOne({ _id: id });
}

async function unshareDocument({ documentId, sharedWithId }) {
  return sharesDb.remove({ document_id: documentId, shared_with_id: sharedWithId });
}

async function getShareRecord({ documentId, sharedWithId }) {
  return sharesDb.findOne({ document_id: documentId, shared_with_id: sharedWithId });
}

module.exports = {
  getAllUsers, getUserById, getUserByUsername,
  getDocumentsByUser, getDocumentById, createDocument, updateDocument, deleteDocument,
  shareDocument, unshareDocument, getShareRecord,
};
