const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const mammoth = require('mammoth');
const fs = require('fs');
const db = require('./db');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ─── Users ────────────────────────────────────────────────────────────────────

app.get('/api/users', async (req, res) => {
  try {
    const users = await db.getAllUsers();
    res.json(users.map(u => ({ id: u._id, username: u.username, display_name: u.display_name, avatar_color: u.avatar_color })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const u = await db.getUserById(req.params.id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json({ id: u._id, username: u.username, display_name: u.display_name, avatar_color: u.avatar_color });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Documents ────────────────────────────────────────────────────────────────

app.get('/api/documents', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const data = await db.getDocumentsByUser(userId);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/documents/:id', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const doc = await db.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const isOwner = doc.owner_id === userId;
    const share = await db.getShareRecord({ documentId: req.params.id, sharedWithId: userId });
    if (!isOwner && !share) return res.status(403).json({ error: 'Access denied' });

    res.json({ ...doc, relationship: isOwner ? 'owner' : 'shared', permission: share?.permission || 'edit' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/documents', async (req, res) => {
  const { title, content, ownerId } = req.body;
  if (!ownerId) return res.status(400).json({ error: 'ownerId required' });
  try {
    const doc = await db.createDocument({ title, content, ownerId });
    res.status(201).json({ ...doc, id: doc._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/documents/:id', async (req, res) => {
  const { title, content, userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const doc = await db.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const isOwner = doc.owner_id === userId;
    const share = await db.getShareRecord({ documentId: req.params.id, sharedWithId: userId });
    const canEdit = isOwner || share?.permission === 'edit';
    if (!canEdit) return res.status(403).json({ error: 'No edit permission' });

    const updated = await db.updateDocument(req.params.id, { title, content });
    res.json({ ...updated, id: updated._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/documents/:id', async (req, res) => {
  const { userId } = req.query;
  try {
    const doc = await db.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (doc.owner_id !== userId) return res.status(403).json({ error: 'Only owner can delete' });
    await db.deleteDocument(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Sharing ──────────────────────────────────────────────────────────────────

app.post('/api/documents/:id/share', async (req, res) => {
  const { ownerId, shareWithUsername, permission = 'edit' } = req.body;
  if (!ownerId || !shareWithUsername) return res.status(400).json({ error: 'ownerId and shareWithUsername required' });
  try {
    const doc = await db.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.owner_id !== ownerId) return res.status(403).json({ error: 'Only owner can share' });

    const target = await db.getUserByUsername(shareWithUsername);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target._id === ownerId) return res.status(400).json({ error: 'Cannot share with yourself' });

    await db.shareDocument({ documentId: req.params.id, sharedWithId: target._id, permission });
    res.json({ success: true, sharedWith: target.display_name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/documents/:id/share/:shareUserId', async (req, res) => {
  const { ownerId } = req.query;
  try {
    const doc = await db.getDocumentById(req.params.id);
    if (!doc || doc.owner_id !== ownerId) return res.status(403).json({ error: 'Forbidden' });
    await db.unshareDocument({ documentId: req.params.id, sharedWithId: req.params.shareUserId });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── File Upload ──────────────────────────────────────────────────────────────

const UPLOADS_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.txt', '.md', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.includes(ext) ? cb(null, true) : cb(new Error('Only .txt, .md, and .docx files are supported'));
  },
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { ownerId } = req.body;
  if (!ownerId) return res.status(400).json({ error: 'ownerId required' });

  const ext = path.extname(req.file.originalname).toLowerCase();
  try {
    let textContent = '';
    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: req.file.path });
      textContent = result.value;
    } else {
      textContent = fs.readFileSync(req.file.path, 'utf8');
    }

    const paragraphs = textContent.split('\n').filter(l => l.trim()).map(line => ({
      type: 'paragraph', content: [{ type: 'text', text: line }],
    }));

    const content = JSON.stringify({
      type: 'doc',
      content: paragraphs.length > 0 ? paragraphs : [{ type: 'paragraph' }],
    });

    const title = path.basename(req.file.originalname, ext);
    const doc = await db.createDocument({ title, content, ownerId });
    res.status(201).json({ ...doc, id: doc._id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Serve frontend build (production) ───────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const FRONTEND_BUILD = path.join(__dirname, '../frontend/build');
if (fs.existsSync(FRONTEND_BUILD)) {
  app.use(express.static(FRONTEND_BUILD));
  app.get('*', (req, res) => res.sendFile(path.join(FRONTEND_BUILD, 'index.html')));
}

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large (max 10MB)' });
  res.status(400).json({ error: err.message });
});

const PORT = process.env.PORT || 3001;

if (require.main === module) {
  app.listen(PORT, () => console.log(`DocFlow API running on http://localhost:${PORT}`));
}

module.exports = app;
