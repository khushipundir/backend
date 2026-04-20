const request = require('supertest');
const path = require('path');
const fs = require('fs');

// Use a temp data dir so tests don't pollute production data
process.env.DB_DIR = path.join(__dirname, '../test-data');

const app = require('./server');

afterAll(() => {
  // Clean up test data directory
  try {
    fs.rmSync(path.join(__dirname, '../test-data'), { recursive: true, force: true });
  } catch {}
});

// Give nedb time to seed
beforeAll(() => new Promise(r => setTimeout(r, 500)));

describe('Users API', () => {
  test('GET /api/users returns seeded users', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
    const usernames = res.body.map(u => u.username);
    expect(usernames).toContain('alice');
    expect(usernames).toContain('bob');
  });

  test('GET /api/users/:id returns 404 for unknown user', async () => {
    const res = await request(app).get('/api/users/nonexistent-id');
    expect(res.status).toBe(404);
  });

  test('GET /api/users/user-alice returns Alice', async () => {
    const res = await request(app).get('/api/users/user-alice');
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('alice');
    expect(res.body.display_name).toBe('Alice Chen');
  });
});

describe('Documents API', () => {
  test('GET /api/documents without userId returns 400', async () => {
    const res = await request(app).get('/api/documents');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('GET /api/documents returns owned and shared keys', async () => {
    const res = await request(app).get('/api/documents?userId=user-alice');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('owned');
    expect(res.body).toHaveProperty('shared');
  });

  test('POST /api/documents creates a document', async () => {
    const res = await request(app)
      .post('/api/documents')
      .send({ title: 'Test Doc', content: '{}', ownerId: 'user-alice' });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Test Doc');
    expect(res.body.owner_id).toBe('user-alice');
    expect(res.body.id).toBeDefined();
  });

  test('POST /api/documents without ownerId returns 400', async () => {
    const res = await request(app).post('/api/documents').send({ title: 'No owner' });
    expect(res.status).toBe(400);
  });

  test('PUT /api/documents/:id updates the document', async () => {
    const created = await request(app)
      .post('/api/documents')
      .send({ title: 'Original', content: '{}', ownerId: 'user-alice' });

    const updated = await request(app)
      .put(`/api/documents/${created.body.id}`)
      .send({ title: 'Renamed', userId: 'user-alice' });

    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe('Renamed');
  });

  test('PUT /api/documents/:id returns 403 for unauthorized user', async () => {
    const created = await request(app)
      .post('/api/documents')
      .send({ title: 'Private', content: '{}', ownerId: 'user-alice' });

    const res = await request(app)
      .put(`/api/documents/${created.body.id}`)
      .send({ title: 'Hacked', userId: 'user-bob' });

    expect(res.status).toBe(403);
  });

  test('DELETE /api/documents/:id deletes the document', async () => {
    const created = await request(app)
      .post('/api/documents')
      .send({ title: 'To Delete', ownerId: 'user-alice' });
    const id = created.body.id;

    const del = await request(app).delete(`/api/documents/${id}?userId=user-alice`);
    expect(del.status).toBe(200);

    const get = await request(app).get(`/api/documents/${id}?userId=user-alice`);
    expect(get.status).toBe(404);
  });
});

describe('Sharing API', () => {
  test('shares a document with another user', async () => {
    const created = await request(app)
      .post('/api/documents')
      .send({ title: 'Shared Doc', ownerId: 'user-alice' });
    const docId = created.body.id;

    const share = await request(app)
      .post(`/api/documents/${docId}/share`)
      .send({ ownerId: 'user-alice', shareWithUsername: 'bob', permission: 'edit' });

    expect(share.status).toBe(200);
    expect(share.body.success).toBe(true);

    // Bob should see it in shared docs
    const bobDocs = await request(app).get('/api/documents?userId=user-bob');
    const found = bobDocs.body.shared.some(d => d._id === docId || d.id === docId);
    expect(found).toBe(true);
  });

  test('returns 404 when sharing with unknown username', async () => {
    const created = await request(app)
      .post('/api/documents')
      .send({ title: 'Test', ownerId: 'user-alice' });

    const res = await request(app)
      .post(`/api/documents/${created.body.id}/share`)
      .send({ ownerId: 'user-alice', shareWithUsername: 'nobody', permission: 'view' });

    expect(res.status).toBe(404);
  });

  test('returns 403 when non-owner tries to share', async () => {
    const created = await request(app)
      .post('/api/documents')
      .send({ title: 'Alice Doc', ownerId: 'user-alice' });

    const res = await request(app)
      .post(`/api/documents/${created.body.id}/share`)
      .send({ ownerId: 'user-bob', shareWithUsername: 'carol', permission: 'view' });

    expect(res.status).toBe(403);
  });

  test('view-only user cannot edit document', async () => {
    const created = await request(app)
      .post('/api/documents')
      .send({ title: 'View Only Doc', ownerId: 'user-alice' });
    const docId = created.body.id;

    await request(app)
      .post(`/api/documents/${docId}/share`)
      .send({ ownerId: 'user-alice', shareWithUsername: 'carol', permission: 'view' });

    const edit = await request(app)
      .put(`/api/documents/${docId}`)
      .send({ title: 'Edit Attempt', userId: 'user-carol' });

    expect(edit.status).toBe(403);
  });
});
