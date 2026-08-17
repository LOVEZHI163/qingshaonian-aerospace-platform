import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { createPostgresAuthState } from "../src/data/auth-state.js";
import { createPostgresStore } from "../src/data/postgres-store.js";
import { replaceRegistrationAsset } from "../src/services/submission-assets.js";

async function withStore(fn) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const store = createPostgresStore(pool);

  try {
    await store.initialize();
    await fn(store, pool);
  } finally {
    await store.close();
  }
}

test("PostgreSQL store creates normalized tables and seeds an empty database", async () => {
  await withStore(async (store, pool) => {
    const tableRows = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    const tables = new Set(tableRows.rows.map((row) => row.table_name));
    for (const name of ["users", "organizations", "memberships", "events", "projects", "project_groups", "registrations", "results", "certificates", "certificate_import_batches", "certificate_import_errors", "audit_logs", "auth_rate_buckets", "password_reset_challenges", "account_email_tokens"]) {
      assert.equal(tables.has(name), true, `missing table ${name}`);
    }

    const userColumns = await pool.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'users'
    `);
    const userNames = new Set(userColumns.rows.map((row) => row.column_name));
    for (const name of ["email", "email_verified_at", "email_updated_at"]) {
      assert.equal(userNames.has(name), true, `missing users.${name}`);
    }

    const eventColumns = await pool.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'events'
    `);
    const names = new Set(eventColumns.rows.map((row) => row.column_name));
    for (const name of ["registration_start_at", "registration_end_at", "registration_mode", "status", "is_current", "archived_at"]) {
      assert.equal(names.has(name), true, `missing events.${name}`);
    }

    const data = await store.readDb();
    assert.equal(data.users.length, 4);
    assert.equal(data.registrations.length, 2);
    assert.equal(data.registrations[0].awardName, "");
    assert.equal(data.events.filter((event) => event.isCurrent).length, 1);
    assert.equal(data.registrations.every((row) => row.eventId), true);
    assert.equal(data.projects.every((project) => project.allowedGroups.length === 4), true);
  });
});

test("PostgreSQL store round-trips temporary-password fields", async () => {
  await withStore(async (store) => {
    const db = await store.readDb();
    const user = db.users[0];
    const fields = {
      temporaryPasswordCiphertext: "ciphertext-base64",
      temporaryPasswordIv: "iv-base64",
      temporaryPasswordTag: "tag-base64",
      temporaryPasswordCreatedAt: "2026-08-06T00:00:00.000Z"
    };
    Object.assign(user, fields);

    await store.writeDb(db);

    assert.deepEqual((await store.readDb()).users.find((row) => row.id === user.id), {
      ...user,
      ...fields
    });
  });
});

test("PostgreSQL store round-trips verified emails and account email tokens", async () => {
  await withStore(async (store) => {
    const db = await store.readDb();
    const user = db.users[0];
    Object.assign(user, {
      email: "owner@example.com",
      emailVerifiedAt: "2026-08-17T10:00:00.000Z",
      emailUpdatedAt: "2026-08-17T10:00:00.000Z"
    });
    db.accountEmailTokens.push({
      id: "ET1", userId: user.id, purpose: "reset_password",
      targetEmail: "owner@example.com", digest: "a".repeat(64),
      expiresAt: "2026-08-17T10:10:00.000Z", usedAt: null,
      requestIp: "127.0.0.1", createdAt: "2026-08-17T10:00:00.000Z"
    });

    await store.writeDb(db);
    const restored = await store.readDb();

    assert.equal(restored.users.find((row) => row.id === user.id).email, "owner@example.com");
    assert.deepEqual(restored.accountEmailTokens, db.accountEmailTokens);
  });
});

test("012 migration normalizes legacy member rows and restores the active-member constraint", async () => {
  await withStore(async (store, pool) => {
    await pool.query("DROP INDEX memberships_single_active_user_idx");
    await pool.query(`INSERT INTO memberships
      (id, user_id, organization_id, role, status, direction, created_at, updated_at)
      VALUES
      ('MZZ-duplicate', 'U1001', 'O1002', 'member', 'active', 'user_request', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
      ('M-owner-legacy', 'U2001', 'O1001', 'owner', 'active', 'user_request', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z'),
      ('M-unbound-invite', NULL, 'O1002', 'member', 'pending', 'invited', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z')`);
    await pool.query("DELETE FROM schema_migrations WHERE name = '012-membership-data-normalization.sql'");

    await store.initialize();

    const rows = await pool.query("SELECT id, status FROM memberships WHERE id IN ('M1002', 'MZZ-duplicate', 'M-owner-legacy', 'M-unbound-invite') ORDER BY id");
    assert.deepEqual(rows.rows, [
      { id: 'M-owner-legacy', status: 'removed' },
      { id: 'M-unbound-invite', status: 'rejected' },
      { id: 'M1002', status: 'active' },
      { id: 'MZZ-duplicate', status: 'removed' }
    ]);
    await assert.rejects(pool.query(`INSERT INTO memberships
      (id, user_id, organization_id, role, status, direction, created_at, updated_at)
      VALUES ('M-conflict', 'U1001', 'O1002', 'member', 'active', 'user_request', NOW(), NOW())`));
    assert.equal((await pool.query("SELECT 1 FROM schema_migrations WHERE name = '012-membership-data-normalization.sql'")).rowCount, 1);
  });
});

test("PostgreSQL permits pending relations but enforces one active organization per user", async () => {
  await withStore(async (_store, pool) => {
    await pool.query(`INSERT INTO users (id, name, phone, password, type, status, created_at)
      VALUES ('UMEMBER', '成员', '13700009999', 'hash', 'ordinary', 'active', NOW())`);
    await pool.query(`INSERT INTO memberships
      (id, user_id, organization_id, role, status, direction, created_at, updated_at)
      VALUES
      ('MP1', 'UMEMBER', 'O1001', 'member', 'pending', 'user_request', NOW(), NOW()),
      ('MP2', 'UMEMBER', 'O1002', 'member', 'pending', 'organization_invite', NOW(), NOW())`);
    await pool.query("UPDATE memberships SET status = 'active' WHERE id = 'MP1'");
    await assert.rejects(
      pool.query("UPDATE memberships SET status = 'active' WHERE id = 'MP2'"),
      /memberships_single_active_user_idx|memberships_pkey/
    );
  });
});

test("PostgreSQL store round-trips submission modes and private upload assets", async () => {
  await withStore(async (store) => {
    const db = await store.readDb();
    const now = "2026-07-31T00:00:00.000Z";
    const later = "2026-07-31T01:00:00.000Z";

    db.projects[0].submissionMode = "image_video";
    db.registrationUploadSessions.push({
      id: "US1",
      eventId: db.events[0].id,
      projectId: db.projects[0].id,
      ownerUserId: db.users[0].id,
      organizationId: null,
      channel: "admin",
      state: "active",
      createdAt: now,
      expiresAt: later,
      committedAt: null
    });
    db.registrationSubmissionAssets.push({
      id: "SA1",
      registrationId: null,
      uploadSessionId: "US1",
      kind: "artwork_image",
      originalName: "work.png",
      storedName: "original.png",
      filePath: "/data/uploads/submission-assets/SA1/original.png",
      mimeType: "image/png",
      sizeBytes: 100,
      width: 800,
      height: 600,
      durationMs: null,
      uploadedByUserId: db.users[0].id,
      uploadedAt: now,
      cleanedAt: null,
      cleanupReason: "",
      warnings: [" 建议提高视频清晰度 ", "", 42, "建议提高视频清晰度"]
    });

    await store.writeDb(db);
    const reloaded = await store.readDb();

    assert.equal(reloaded.projects[0].submissionMode, "image_video");
    assert.deepEqual(reloaded.registrationUploadSessions, [{
      id: "US1",
      eventId: db.events[0].id,
      projectId: db.projects[0].id,
      ownerUserId: db.users[0].id,
      organizationId: null,
      channel: "admin",
      state: "active",
      createdAt: now,
      expiresAt: later,
      committedAt: null
    }]);
    assert.deepEqual(reloaded.registrationSubmissionAssets, [{
      id: "SA1",
      registrationId: null,
      uploadSessionId: "US1",
      kind: "artwork_image",
      originalName: "work.png",
      storedName: "original.png",
      filePath: "/data/uploads/submission-assets/SA1/original.png",
      mimeType: "image/png",
      sizeBytes: 100,
      width: 800,
      height: 600,
      durationMs: null,
      uploadedByUserId: db.users[0].id,
      uploadedAt: now,
      cleanedAt: null,
      cleanupReason: "",
      warnings: ["建议提高视频清晰度"]
    }]);
  });
});

test("PostgreSQL store upgrades an existing submission-assets table and persists sanitized warning arrays", async () => {
  await withStore(async (store, pool) => {
    await pool.query("ALTER TABLE registration_submission_assets DROP COLUMN IF EXISTS warnings");
    await pool.query("DELETE FROM schema_migrations WHERE name = '010-submission-asset-warnings.sql'");

    await store.initialize();
    const db = await store.readDb();
    const now = "2026-08-01T00:00:00.000Z";
    db.registrationUploadSessions.push({
      id: "US-warning-upgrade", eventId: db.events[0].id, projectId: db.projects[0].id,
      ownerUserId: db.users[0].id, organizationId: null, channel: "personal", state: "active",
      createdAt: now, expiresAt: "2026-08-02T00:00:00.000Z", committedAt: null
    });
    db.registrationSubmissionAssets.push({
      id: "SA-warning-upgrade", registrationId: null, uploadSessionId: "US-warning-upgrade", kind: "artwork_image",
      originalName: "warning.png", storedName: "warning.png", filePath: "/data/uploads/submission-assets/SA-warning-upgrade/warning.png",
      mimeType: "image/png", sizeBytes: 100, width: 800, height: 600, durationMs: null,
      uploadedByUserId: db.users[0].id, uploadedAt: now, cleanedAt: null, cleanupReason: "",
      warnings: ["低清晰度", null, "低清晰度", "  请补拍  "]
    });
    await store.writeDb(db);

    const persisted = await store.readDb();
    assert.deepEqual(persisted.registrationSubmissionAssets.find((row) => row.id === "SA-warning-upgrade").warnings, ["低清晰度", "请补拍"]);
    const stored = await pool.query("SELECT warnings FROM registration_submission_assets WHERE id = 'SA-warning-upgrade'");
    assert.deepEqual(stored.rows[0].warnings, ["低清晰度", "请补拍"]);
    const migration = await pool.query("SELECT 1 FROM schema_migrations WHERE name = '010-submission-asset-warnings.sql'");
    assert.equal(migration.rowCount, 1);
  });
});

test("PostgreSQL store persists a registration asset replacement without changing the bound asset identity", async () => {
  await withStore(async (store) => {
    const db = await store.readDb();
    const registration = db.registrations.find((row) => row.personalUserId === "U1001");
    const project = db.projects.find((row) => row.id === registration.projectId);
    const actor = db.users.find((row) => row.id === registration.personalUserId);
    const timestamp = "2026-07-31T00:00:00.000Z";
    project.submissionMode = "image_video";
    db.registrationUploadSessions.push(
      { id: "US-bound", eventId: registration.eventId, projectId: registration.projectId, ownerUserId: actor.id, organizationId: null, state: "committed", createdAt: timestamp, expiresAt: "2030-01-01T00:00:00.000Z", committedAt: timestamp },
      { id: "US-source", eventId: registration.eventId, projectId: registration.projectId, ownerUserId: actor.id, organizationId: null, state: "active", createdAt: timestamp, expiresAt: "2030-01-01T00:00:00.000Z", committedAt: null }
    );
    db.registrationSubmissionAssets.push(
      {
        id: "SA-bound", registrationId: registration.id, uploadSessionId: "US-bound", kind: "artwork_image",
        originalName: "old.png", storedName: "old.png", filePath: "/data/uploads/submission-assets/SA-bound/old.png",
        mimeType: "image/png", sizeBytes: 100, width: 800, height: 600, durationMs: null,
        uploadedByUserId: actor.id, uploadedAt: timestamp, cleanedAt: null, cleanupReason: ""
      },
      {
        id: "SA-source", registrationId: null, uploadSessionId: "US-source", kind: "artwork_image",
        originalName: "replacement.png", storedName: "replacement.png", filePath: "/data/uploads/submission-assets/SA-source/replacement.png",
        mimeType: "image/png", sizeBytes: 200, width: 1024, height: 768, durationMs: null,
        uploadedByUserId: actor.id, uploadedAt: timestamp, cleanedAt: null, cleanupReason: ""
      }
    );
    await store.writeDb(db);

    const replacementDb = await store.readDb();
    const replacementRegistration = replacementDb.registrations.find((row) => row.id === registration.id);
    const source = replacementDb.registrationSubmissionAssets.find((row) => row.id === "SA-source");
    replaceRegistrationAsset({
      db: replacementDb, registration: replacementRegistration, kind: "artwork_image", uploadedAsset: source,
      actor, channel: "personal", now: () => timestamp
    });
    await store.writeDb(replacementDb);

    const reloaded = await store.readDb();
    assert.deepEqual(reloaded.registrationSubmissionAssets.filter((row) => row.registrationId === registration.id).map((row) => ({
      id: row.id, originalName: row.originalName, sizeBytes: row.sizeBytes, width: row.width, height: row.height
    })), [{ id: "SA-bound", originalName: "replacement.png", sizeBytes: 200, width: 1024, height: 768 }]);
    assert.equal(reloaded.registrationSubmissionAssets.some((row) => row.id === "SA-source"), false);
  });
});

test("multi-event account schema constrains ownership and registration identity", async () => {
  await withStore(async (store, pool) => {
    const tables = new Set((await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
    `)).rows.map((row) => row.table_name));
    assert.equal(tables.has("organization_event_participations"), true);

    const columns = new Set((await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'registrations'
    `)).rows.map((row) => row.column_name));
    for (const name of ["created_by_user_id", "personal_user_id", "created_via"]) {
      assert.equal(columns.has(name), true, `missing registrations.${name}`);
    }
    assert.equal(columns.has("user_id"), false);

    const certificateColumns = new Set((await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'certificates'
    `)).rows.map((row) => row.column_name));
    assert.equal(certificateColumns.has("user_id"), false);
    assert.equal(certificateColumns.has("organization_id"), false);

    await assert.rejects(pool.query(
      "INSERT INTO organizations (id,name,code,owner_user_id,status,created_at) VALUES ('O-X','X','X','U2001','active',NOW())"
    ));
  });
});

test("PostgreSQL store leaves production empty databases unseeded", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const store = createPostgresStore(new Pool(), { seedOnEmpty: false });

  try {
    await store.initialize();
    const data = await store.readDb();
    assert.deepEqual(data.users, []);
    assert.deepEqual(data.organizations, []);
    assert.deepEqual(data.registrations, []);
  } finally {
    await store.close();
  }
});

test("public site schema creates constrained tables, indexes, and one default settings row", async () => {
  await withStore(async (store, pool) => {
    const tableRows = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    const tables = new Set(tableRows.rows.map((row) => row.table_name));
    for (const name of ["site_settings", "event_public_profiles", "content_posts", "media_assets", "content_attachments", "site_content_import_batches"]) {
      assert.equal(tables.has(name), true, `missing table ${name}`);
    }

    const contentColumns = new Set((await pool.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'content_posts'
    `)).rows.map((row) => row.column_name));
    for (const name of ["source_url", "source_url_fingerprint", "source_name", "source_author", "source_published_at", "imported_at"]) {
      assert.equal(contentColumns.has(name), true, `missing content_posts.${name}`);
    }

    for (const statement of [
      "CREATE INDEX content_posts_status_publish_at_idx ON content_posts(status, publish_at)",
      "CREATE INDEX content_posts_event_id_type_idx ON content_posts(event_id, type)",
      "CREATE INDEX event_public_profiles_is_visible_display_order_idx ON event_public_profiles(is_visible, display_order)"
    ]) {
      await assert.rejects(pool.query(statement), /already exists/i);
    }

    const data = await store.readDb();
    assert.equal(data.siteSettings.id, "default");
    assert.equal(data.siteSettings.version, 1);
    assert.equal(data.eventPublicProfiles.length, 0);
    assert.equal(data.contentPosts.length, 0);
    assert.equal(data.mediaAssets.length, 0);
    assert.equal(data.contentAttachments.length, 0);
    assert.deepEqual(data.siteContentImportBatches, []);

    await store.initialize();
    assert.equal((await store.readDb()).siteSettings.version, 1);

    await assert.rejects(pool.query(`
      INSERT INTO site_settings (id, platform_name, seo_title)
      VALUES ('not-default', 'test', 'test')
    `));
    await pool.query(`
      INSERT INTO event_public_profiles (event_id, slug)
      VALUES ('wz-aerospace-2026', 'public-event')
    `);
    await pool.query(`
      INSERT INTO events
        (id, name, theme, date_label, venue, registration_deadline, contact,
         registration_start_at, registration_end_at, registration_mode, status, is_current)
      VALUES
        ('event-public-unique', '测试赛事', '测试', '2027', '测试场馆', '2027-01-01', '测试',
         '2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'automatic', 'published', FALSE)
    `);
    await assert.rejects(pool.query(`
      INSERT INTO event_public_profiles (event_id, slug)
      VALUES ('event-public-unique', 'public-event')
    `));
  });
});

test("PostgreSQL store upgrades a legacy content_posts table before creating import indexes", async () => {
  await withStore(async (store, pool) => {
    await pool.query("DROP INDEX content_posts_source_url_fingerprint_unique");
    for (const column of [
      "source_url",
      "source_url_fingerprint",
      "source_name",
      "source_author",
      "source_published_at",
      "imported_at"
    ]) {
      await pool.query(`ALTER TABLE content_posts DROP COLUMN ${column}`);
    }
    await pool.query("DELETE FROM schema_migrations WHERE name = '016-site-content-imports.sql'");

    await store.initialize();

    const columns = new Set((await pool.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'content_posts'
    `)).rows.map((row) => row.column_name));
    assert.equal(columns.has("source_url_fingerprint"), true);
    assert.equal((await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name = '016-site-content-imports.sql'"
    )).rowCount, 1);
    await assert.rejects(
      pool.query("CREATE UNIQUE INDEX content_posts_source_url_fingerprint_unique ON content_posts(source_url_fingerprint)"),
      /already exists/i
    );
  });
});

test("PostgreSQL public site data maps snapshots with versioned content and media attachments", async () => {
  await withStore(async (store) => {
    const data = await store.readDb();
    data.siteSettings = { ...data.siteSettings, platformIntro: "公开赛事平台" };
    data.mediaAssets.push({
      id: "MEDIA-1",
      eventId: "wz-aerospace-2026",
      purpose: "cover",
      visibility: "public",
      originalName: "cover.png",
      storedName: "cover-1.png",
      filePath: "/uploads/cover-1.png",
      mimeType: "image/png",
      sizeBytes: 128,
      width: 640,
      height: 480,
      variants: { thumbnail: "/uploads/cover-thumb.png" },
      createdBy: "U9001",
      createdAt: "2026-07-19T00:00:00.000Z",
      cleanedAt: null
    });
    data.eventPublicProfiles.push({
      eventId: "wz-aerospace-2026",
      slug: "wz-2026",
      slogan: "飞向未来",
      summary: "赛事公开资料",
      isVisible: true,
      displayOrder: 1,
      heroMediaId: "MEDIA-1",
      version: 3,
      updatedAt: "2026-07-19T00:00:00.000Z"
    });
    data.contentPosts.push({
      id: "POST-1",
      slug: "welcome",
      eventId: "wz-aerospace-2026",
      type: "announcement",
      title: "欢迎",
      summary: "赛事公告",
      bodyHtml: "<p>欢迎</p>",
      status: "published",
      publishAt: "2026-07-19T01:00:00.000Z",
      pinned: true,
      sortOrder: 1,
      coverMediaId: "MEDIA-1",
      sourceUrl: "https://news.example.cn/aerospace",
      sourceUrlFingerprint: "54a2fe4d6ce3d3aa82d3739df0aa07755d99bc8cbc157bb025ba55d11cec8cb4",
      sourceName: "温州教育新闻网",
      sourceAuthor: "王老师",
      sourcePublishedAt: "2026-07-18T08:00:00.000Z",
      importedAt: "2026-07-19T00:00:00.000Z",
      version: 4,
      createdBy: "U9001",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z"
    });
    data.contentAttachments.push({ contentId: "POST-1", mediaId: "MEDIA-1", label: "封面", displayOrder: 0 });
    data.siteContentImportBatches.push({
      id: "SCI-1",
      createdBy: "U9001",
      sourceUrl: "https://news.example.cn/aerospace?utm_source=feed",
      normalizedSourceUrl: "https://news.example.cn/aerospace",
      sourceUrlFingerprint: "54a2fe4d6ce3d3aa82d3739df0aa07755d99bc8cbc157bb025ba55d11cec8cb4",
      sourceType: "web",
      sourceName: "温州教育新闻网",
      sourceAuthor: "王老师",
      sourcePublishedAt: "2026-07-18T08:00:00.000Z",
      title: "航空科普活动",
      summary: "摘要",
      bodyTemplateHtml: '<p>正文<img src="@@SITE_IMPORT_IMAGE:IMG1@@"></p>',
      warnings: [{ code: "IMPORT_IMAGE_FAILED", message: "一张图片下载失败" }],
      images: [{
        id: "IMG1",
        originalUrl: "https://news.example.cn/photo.jpg",
        resolvedUrl: "https://cdn.example.cn/photo.jpg",
        originalName: "photo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 128,
        width: 1200,
        height: 800,
        stagePath: "/data/uploads/site-content-import-staging/SCI-1/IMG1.jpg",
        status: "ready",
        reasonCode: null,
        reason: ""
      }],
      status: "ready",
      createdAt: "2026-07-19T00:00:00.000Z",
      expiresAt: "2026-07-19T00:30:00.000Z"
    });

    await store.writeDb(data);
    const persisted = await store.readDb();

    assert.equal(persisted.siteSettings.platformIntro, "公开赛事平台");
    assert.equal(persisted.siteSettings.version, data.siteSettings.version + 1);
    assert.deepEqual(persisted.eventPublicProfiles, [data.eventPublicProfiles[0]]);
    assert.deepEqual(persisted.contentPosts, [data.contentPosts[0]]);
    assert.deepEqual(persisted.mediaAssets, [data.mediaAssets[0]]);
    assert.deepEqual(persisted.contentAttachments, [data.contentAttachments[0]]);
    assert.deepEqual(persisted.siteContentImportBatches, [data.siteContentImportBatches[0]]);

    persisted.siteContentImportBatches = [];
    await store.writeDb(persisted);
    assert.equal((await store.readDb()).siteContentImportBatches.length, 0);
  });
});

test("PostgreSQL public site settings reject stale versioned snapshots", async () => {
  await withStore(async (store) => {
    const stale = await store.readDb();
    const next = structuredClone(stale);
    next.siteSettings.platformIntro = "最新设置";

    await store.writeDb(next);
    await assert.rejects(store.writeDb(stale), /site_settings version conflict/i);
  });
});

test("PostgreSQL public event profiles reject stale versioned snapshots", async () => {
  await withStore(async (store) => {
    const initial = await store.readDb();
    initial.eventPublicProfiles.push({
      eventId: "wz-aerospace-2026",
      slug: "profile-versioning",
      slogan: "初始标语",
      summary: "",
      isVisible: false,
      displayOrder: 0,
      heroMediaId: null,
      version: 1,
      updatedAt: "2026-07-19T00:00:00.000Z"
    });
    await store.writeDb(initial);

    const stale = await store.readDb();
    const next = structuredClone(stale);
    next.eventPublicProfiles[0].slogan = "最新标语";
    await store.writeDb(next);

    await assert.rejects(store.writeDb(stale), /event_public_profiles version conflict/i);
  });
});

test("PostgreSQL content posts reject stale versioned snapshots", async () => {
  await withStore(async (store) => {
    const initial = await store.readDb();
    initial.contentPosts.push({
      id: "POST-VERSIONING",
      slug: "post-versioning",
      eventId: "wz-aerospace-2026",
      type: "news",
      title: "初始标题",
      summary: "",
      bodyHtml: "",
      status: "draft",
      publishAt: null,
      pinned: false,
      sortOrder: 0,
      coverMediaId: null,
      version: 1,
      createdBy: "U9001",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z"
    });
    await store.writeDb(initial);

    const stale = await store.readDb();
    const next = structuredClone(stale);
    next.contentPosts[0].title = "最新标题";
    await store.writeDb(next);

    await assert.rejects(store.writeDb(stale), /content_posts version conflict/i);
  });
});

test("PostgreSQL site settings reject an interleaved same-version write after its stale read", async () => {
  await withStore(async (store, pool) => {
    const peer = createPostgresStore(pool);
    const stale = await store.readDb();
    const first = structuredClone(stale);
    const second = structuredClone(stale);
    first.siteSettings.platformIntro = "第一个写入";
    second.siteSettings.platformIntro = "第二个写入";
    const staleSettingsRow = (await pool.query("SELECT * FROM site_settings WHERE id = $1", ["default"])).rows[0];
    await store.writeDb(first);

    const connect = pool.connect.bind(pool);
    pool.connect = async () => {
      const client = await connect();
      const query = client.query.bind(client);
      client.query = async (...args) => {
        if (args[0] === "SELECT * FROM site_settings WHERE id = $1") {
          return { rowCount: 1, rows: [staleSettingsRow] };
        }
        return query(...args);
      };
      return client;
    };

    await assert.rejects(peer.writeDb(second), /site_settings version conflict/i);
    const persisted = await store.readDb();
    assert.equal(persisted.siteSettings.platformIntro, "第一个写入");
    assert.equal(persisted.siteSettings.version, stale.siteSettings.version + 1);
  });
});

test("PostgreSQL unchanged public-site snapshots keep editable versions", async () => {
  await withStore(async (store) => {
    const initial = await store.readDb();
    initial.eventPublicProfiles.push({
      eventId: "wz-aerospace-2026",
      slug: "unchanged-profile",
      slogan: "",
      summary: "",
      isVisible: false,
      displayOrder: 0,
      heroMediaId: null,
      version: 1,
      updatedAt: "2026-07-19T00:00:00.000Z"
    });
    initial.contentPosts.push({
      id: "POST-UNCHANGED",
      slug: "unchanged-post",
      eventId: "wz-aerospace-2026",
      type: "news",
      title: "未修改",
      summary: "",
      bodyHtml: "",
      status: "draft",
      publishAt: null,
      pinned: false,
      sortOrder: 0,
      coverMediaId: null,
      version: 1,
      createdBy: "U9001",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z"
    });
    await store.writeDb(initial);

    const unchanged = await store.readDb();
    const versions = {
      siteSettings: unchanged.siteSettings.version,
      profile: unchanged.eventPublicProfiles[0].version,
      post: unchanged.contentPosts[0].version
    };
    await store.writeDb(unchanged);
    const persisted = await store.readDb();

    assert.equal(persisted.siteSettings.version, versions.siteSettings);
    assert.equal(persisted.eventPublicProfiles[0].version, versions.profile);
    assert.equal(persisted.contentPosts[0].version, versions.post);
  });
});

test("PostgreSQL store persists mutations, results, and deletions", async () => {
  await withStore(async (store) => {
    const data = await store.readDb();
    data.registrations[0].awardName = "一等奖";
    data.registrations[0].rank = "1";
    data.registrations[0].score = "98.5";
    data.registrations[0].resultRecordedAt = "2026-07-16T01:00:00.000Z";
    data.memberships = data.memberships.filter((row) => row.id !== "M1003");
    data.auditLogs.push({
      id: "A-PERSIST",
      actorUserId: "U9001",
      actorName: "赛事管理员",
      action: "registration.review",
      targetType: "registration",
      targetId: "R20260627001",
      summary: "报名审核为通过",
      createdAt: "2026-07-18T08:00:00.000Z"
    });

    await store.writeDb(data);
    const persisted = await store.readDb();

    assert.equal(persisted.registrations[0].awardName, "一等奖");
    assert.equal(persisted.registrations[0].score, "98.5");
    assert.equal(persisted.memberships.some((row) => row.id === "M1003"), false);
    assert.deepEqual(persisted.auditLogs, [{
      id: "A-PERSIST",
      actorUserId: "U9001",
      actorName: "赛事管理员",
      action: "registration.review",
      targetType: "registration",
      targetId: "R20260627001",
      summary: "报名审核为通过",
      createdAt: "2026-07-18T08:00:00.000Z"
    }]);
  });
});

test("PostgreSQL store switches the unique current event and removes projects without registrations", async () => {
  await withStore(async (store, pool) => {
    const data = await store.readDb();
    data.events.push({
      id: "event-next",
      name: "下一届赛事",
      theme: "下一届主题",
      dateLabel: "2027年10月1日",
      venue: "测试场馆",
      contact: "测试联系人",
      registrationStartAt: "2027-08-01T00:00:00.000Z",
      registrationEndAt: "2027-09-01T00:00:00.000Z",
      registrationMode: "automatic",
      status: "published",
      isCurrent: true,
      archivedAt: null,
      createdAt: "2027-01-01T00:00:00.000Z",
      updatedAt: "2027-01-01T00:00:00.000Z"
    });
    data.events.find((event) => event.id === "wz-aerospace-2026").isCurrent = false;
    data.projects.push({
      id: "project-removable",
      eventId: "event-next",
      name: "可删除赛项",
      type: "individual",
      category: "测试",
      enabled: true,
      instructorRequired: false,
      displayOrder: 0,
      allowedGroups: ["小学低段"]
    });
    data.projectGroups.push({ projectId: "project-removable", groupName: "小学低段" });
    await store.writeDb(data);

    const switched = await store.readDb();
    assert.deepEqual(switched.events.filter((event) => event.isCurrent).map((event) => event.id), ["event-next"]);
    switched.events.find((event) => event.id === "wz-aerospace-2026").isCurrent = true;
    switched.events.find((event) => event.id === "event-next").isCurrent = false;
    switched.projects = switched.projects.filter((project) => project.id !== "project-removable");
    switched.projectGroups = switched.projectGroups.filter((group) => group.projectId !== "project-removable");
    await store.writeDb(switched);

    const persisted = await store.readDb();
    assert.deepEqual(persisted.events.filter((event) => event.isCurrent).map((event) => event.id), ["wz-aerospace-2026"]);
    assert.equal(persisted.projects.some((project) => project.id === "project-removable"), false);
    assert.equal((await pool.query("SELECT 1 FROM project_groups WHERE project_id = $1", ["project-removable"])).rowCount, 0);
  });
});

test("PostgreSQL store removes events omitted by a committed snapshot", async () => {
  await withStore(async (store, pool) => {
    const data = await store.readDb();
    data.events.push({
      id: "event-removable",
      name: "可彻底删除赛事",
      theme: "历史赛事",
      dateLabel: "2025年",
      venue: "温州",
      contact: "组委会",
      registrationStartAt: "2025-01-01T00:00:00.000Z",
      registrationEndAt: "2025-02-01T00:00:00.000Z",
      registrationMode: "automatic",
      status: "archived",
      isCurrent: false,
      archivedAt: "2025-03-01T00:00:00.000Z",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-03-01T00:00:00.000Z"
    });
    await store.writeDb(data);

    const next = await store.readDb();
    next.events = next.events.filter((event) => event.id !== "event-removable");
    await store.writeDb(next);

    assert.equal((await pool.query("SELECT 1 FROM events WHERE id = $1", ["event-removable"])).rowCount, 0);
    assert.equal((await store.readDb()).events.some((event) => event.id === "event-removable"), false);
  });
});

test("PostgreSQL restart preserves an administrator-selected project group subset", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const first = createPostgresStore(new Pool());
  let second;

  try {
    await first.initialize();
    const data = await first.readDb();
    const project = data.projects.find((row) => row.id === "rocket-duration");
    project.allowedGroups = ["小学低段"];
    data.projectGroups = data.projectGroups.filter((row) => row.projectId !== project.id);
    data.projectGroups.push({ projectId: project.id, groupName: "小学低段" });
    await first.writeDb(data);
    await first.close();

    second = createPostgresStore(new Pool());
    await second.initialize();
    await second.initialize();
    const restarted = await second.readDb();
    assert.deepEqual(restarted.projects.find((row) => row.id === project.id).allowedGroups, ["小学低段"]);
    assert.deepEqual(restarted.projectGroups.filter((row) => row.projectId === project.id), [
      { projectId: project.id, groupName: "小学低段" }
    ]);
  } finally {
    if (second) await second.close();
    else await first.close();
  }
});

test("PostgreSQL schema enforces unique phone and registration foreign keys", async () => {
  await withStore(async (_store, pool) => {
    await assert.rejects(
      pool.query(
        `INSERT INTO users (id, name, phone, password, type, status, created_at)
         VALUES ('UDUP', '重复手机号', '13800000001', 'x', 'ordinary', 'active', NOW())`
      )
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO registrations
          (id, event_id, source, user_id, organization_id, organization_name, athlete, athlete_key,
           group_name, project_id, project_name, project_type, instructor, status, reject_reason, created_at, updated_at)
         VALUES
          ('RBAD', 'wz-aerospace-2026', '普通用户', 'UNOPE', NULL, '', '{}', '', '',
           'paper-plane-gate', '', 'individual', '', 'pending', '', NOW(), NOW())`
      )
    );

    await assert.rejects(pool.query(`
      INSERT INTO events
        (id, name, theme, date_label, venue, registration_deadline, contact,
         registration_start_at, registration_end_at, registration_mode, status, is_current)
      VALUES
        ('duplicate-current', '重复当前赛事', '主题', '2027年', '场馆', '2027-01-01', '联系人',
         '2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'automatic', 'published', TRUE)
    `));

    await assert.rejects(pool.query(`
      INSERT INTO certificates
        (id, registration_id, slot, title, file_name, stored_name, file_path, status, source, uploaded_at)
      VALUES ('C-INVALID-SLOT', 'R20260627001', 3, '非法槽位', 'invalid.pdf', 'invalid.pdf', '/tmp/invalid.pdf', 'draft', 'manual', NOW())
    `), /check/i);
  });
});

test("PostgreSQL store repairs a missing certificate slot check after migration 003 was already recorded", async () => {
  await withStore(async (store, pool) => {
    const migration003 = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name = '003-certificate-slots-imports.sql'"
    );
    assert.equal(migration003.rowCount, 1);

    await pool.query("ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_slot_check");
    await pool.query(
      "DELETE FROM schema_migrations WHERE name = '003a-certificate-slot-check.sql'"
    );

    await store.initialize();

    const compensation = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name = '003a-certificate-slot-check.sql'"
    );
    assert.equal(compensation.rowCount, 1);
    await assert.rejects(pool.query(`
      INSERT INTO certificates
        (id, registration_id, slot, title, file_name, stored_name, file_path, status, source, uploaded_at)
      VALUES ('C-REPAIRED-INVALID-SLOT', 'R20260627001', 3, 'invalid slot', 'invalid.pdf', 'invalid.pdf', '/tmp/invalid.pdf', 'draft', 'manual', NOW())
    `), /check/i);
  });
});

test("PostgreSQL auth state atomically enforces limits and consumes challenges once across instances", async () => {
  await withStore(async (store, pool) => {
    const now = Date.parse("2026-07-17T00:00:00.000Z");
    const peer = createPostgresAuthState(pool);
    const states = [store.authState, peer];
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => states[index % 2].consumeRateLimits([
      { key: "login:ip:127.0.0.1", limit: 5, windowMs: 60_000 }
    ], now)));
    assert.equal(results.filter(Boolean).length, 5);

    for (let index = 0; index < 5; index += 1) {
      await states[index % 2].releaseRateLimits(["login:ip:127.0.0.1"], now);
    }
    const emptyBuckets = await pool.query("SELECT key FROM auth_rate_buckets WHERE key = $1", ["login:ip:127.0.0.1"]);
    assert.equal(emptyBuckets.rowCount, 0);

    await store.authState.saveChallenge({ purpose: "sms-password-reset", phone: "13800000001", digest: "b".repeat(64), expiresAt: now + 300_000 });
    const consumed = await Promise.all(states.map((state) => state.consumeChallenge({
      purpose: "sms-password-reset", phone: "13800000001", digest: "b".repeat(64), now, maxAttempts: 5
    })));
    assert.equal(consumed.filter(Boolean).length, 1);

    await peer.saveChallenge({ purpose: "sms-password-reset", phone: "13800000002", digest: "c".repeat(64), expiresAt: now + 1 });
    await store.authState.consumeChallenge({ purpose: "sms-password-reset", phone: "13800000003", digest: "d".repeat(64), now: now + 2, maxAttempts: 5 });
    const expired = await pool.query("SELECT phone FROM password_reset_challenges WHERE phone = $1", ["13800000002"]);
    assert.equal(expired.rowCount, 0);
  });
});

test("PostgreSQL auth challenge purposes are isolated and conditionally delete only the expected digest", async () => {
  await withStore(async (store) => {
    const now = Date.parse("2026-08-18T00:00:00.000Z");
    const phone = "13800000009";
    const loginDigest = "1".repeat(64);
    const resetDigest = "2".repeat(64);
    const oldDigest = "3".repeat(64);
    const newDigest = "4".repeat(64);

    await store.authState.saveChallenge({
      purpose: "sms-login", phone, digest: loginDigest, expiresAt: now + 300_000, attempts: 0
    });
    await store.authState.saveChallenge({
      purpose: "sms-password-reset", phone, digest: resetDigest, expiresAt: now + 300_000, attempts: 0
    });
    assert.equal(await store.authState.consumeChallenge({
      purpose: "sms-login", phone, digest: resetDigest, now, maxAttempts: 5
    }), false);
    assert.equal(await store.authState.consumeChallenge({
      purpose: "sms-password-reset", phone, digest: resetDigest, now, maxAttempts: 5
    }), true);
    assert.equal(await store.authState.consumeChallenge({
      purpose: "sms-login", phone, digest: loginDigest, now, maxAttempts: 5
    }), true);

    await store.authState.saveChallenge({
      purpose: "sms-login", phone, digest: oldDigest, expiresAt: now + 300_000, attempts: 0
    });
    await store.authState.saveChallenge({
      purpose: "sms-login", phone, digest: newDigest, expiresAt: now + 300_000, attempts: 0
    });
    await store.authState.deleteChallenge({ purpose: "sms-login", phone, digest: oldDigest });
    assert.equal(await store.authState.consumeChallenge({
      purpose: "sms-login", phone, digest: newDigest, now, maxAttempts: 5
    }), true);
  });
});

test("PostgreSQL auth state handles burst contention without surfacing storage conflicts", async () => {
  await withStore(async (_store, pool) => {
    const now = Date.parse("2026-07-17T00:00:00.000Z");
    const states = Array.from({ length: 10 }, () => createPostgresAuthState(pool));
    const settled = await Promise.allSettled(Array.from({ length: 50 }, (_, index) => states[index % states.length].consumeRateLimits([
      { key: "login:ip:burst", limit: 20, windowMs: 60_000 }
    ], now)));
    assert.equal(settled.every((result) => result.status === "fulfilled"), true);
    assert.equal(settled.filter((result) => result.status === "fulfilled" && result.value).length, 20);
  });
});

test("denied PostgreSQL requests do not retain empty buckets for rotating phone keys", async () => {
  await withStore(async (store, pool) => {
    const now = Date.parse("2026-07-17T00:00:00.000Z");
    assert.equal(await store.authState.consumeRateLimits([
      { key: "login:ip:saturated", limit: 1, windowMs: 60_000 }
    ], now), true);

    const states = Array.from({ length: 5 }, () => createPostgresAuthState(pool));
    const denied = await Promise.all(Array.from({ length: 25 }, (_, index) => states[index % states.length].consumeRateLimits([
      { key: `login:phone:rotating:${index}`, limit: 5, windowMs: 60_000 },
      { key: "login:ip:saturated", limit: 1, windowMs: 60_000 }
    ], now + 1)));
    assert.equal(denied.every((allowed) => allowed === false), true);

    const emptyPhones = await pool.query("SELECT key FROM auth_rate_buckets WHERE key LIKE 'login:phone:rotating:%'");
    assert.equal(emptyPhones.rowCount, 0);
  });
});

test("PostgreSQL store rejects invalid registration modes and project groups", async () => {
  await withStore(async (store) => {
    const invalidMode = await store.readDb();
    invalidMode.events[0].registrationMode = "manual";
    await assert.rejects(store.writeDb(invalidMode), /registration mode/i);

    const invalidGroup = await store.readDb();
    invalidGroup.projectGroups[0].groupName = "大学组";
    await assert.rejects(store.writeDb(invalidGroup), /project group/i);
  });
});

test("PostgreSQL store rejects nested plaintext athlete identity fields before any snapshot rows change", async () => {
  await withStore(async (store) => {
    const db = await store.readDb();
    db.registrations[0].athlete.emergencyContact = { name: "陈家长", phone: "13800000001" };
    await store.writeDb(db);
    const persisted = await store.readDb();
    assert.deepEqual(persisted.registrations[0].athlete.emergencyContact, { name: "陈家长", phone: "13800000001" });

    const invalid = structuredClone(persisted);
    invalid.registrations[0].status = "approved";
    invalid.registrations[0].athlete.profile = { identityNumber: "330000200001010001" };
    await assert.rejects(store.writeDb(invalid), /identity field/i);

    const afterRejectedWrite = await store.readDb();
    assert.equal(afterRejectedWrite.registrations[0].status, persisted.registrations[0].status);
    assert.equal("profile" in afterRejectedWrite.registrations[0].athlete, false);
  });
});

test("PostgreSQL store upgrades a legacy schema without losing existing records", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const store = createPostgresStore(pool);

  assert.equal(store.pool, pool);
  assert.equal(Object.getOwnPropertyDescriptor(store, "pool").writable, false);

  try {
    await pool.query(`
      CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, password TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, owner_user_id TEXT NOT NULL REFERENCES users(id), contact_name TEXT NOT NULL DEFAULT '', contact_phone TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE memberships (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), invited_phone TEXT, invited_name TEXT, organization_id TEXT NOT NULL REFERENCES organizations(id), role TEXT NOT NULL, status TEXT NOT NULL, direction TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, UNIQUE (user_id, organization_id));
      CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT NOT NULL, date_label TEXT NOT NULL, venue TEXT NOT NULL, registration_deadline TEXT NOT NULL, contact TEXT NOT NULL);
      CREATE TABLE projects (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL);
      CREATE TABLE registrations (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), source TEXT NOT NULL, user_id TEXT REFERENCES users(id), organization_id TEXT REFERENCES organizations(id), organization_name TEXT NOT NULL DEFAULT '', athlete JSONB NOT NULL, athlete_key TEXT NOT NULL, group_name TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), project_name TEXT NOT NULL, project_type TEXT NOT NULL, instructor TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, reject_reason TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE results (registration_id TEXT PRIMARY KEY REFERENCES registrations(id) ON DELETE CASCADE, award_name TEXT NOT NULL DEFAULT '', rank TEXT NOT NULL DEFAULT '', score TEXT NOT NULL DEFAULT '', recorded_at TIMESTAMPTZ);
      CREATE TABLE certificates (id TEXT PRIMARY KEY, registration_id TEXT NOT NULL UNIQUE REFERENCES registrations(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id), organization_id TEXT REFERENCES organizations(id), certificate_no TEXT NOT NULL, slot SMALLINT NOT NULL DEFAULT 1, file_name TEXT NOT NULL, stored_name TEXT NOT NULL, file_path TEXT NOT NULL, award_name TEXT NOT NULL DEFAULT '', rank TEXT NOT NULL DEFAULT '', score TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, uploaded_at TIMESTAMPTZ NOT NULL, published_at TIMESTAMPTZ);
    `);
    await pool.query(`
      INSERT INTO users VALUES ('ULEGACY', 'Legacy User', '13000000000', 'secret', 'ordinary', 'active', '2026-01-01T00:00:00.000Z');
      INSERT INTO organizations VALUES ('OLEGACY', 'Legacy Org', 'LEGACY', 'ULEGACY', 'Owner', '13000000000', 'active', '2026-01-01T00:00:00.000Z');
      INSERT INTO memberships VALUES ('MLEGACY', 'ULEGACY', NULL, NULL, 'OLEGACY', 'owner', 'active', 'system', 'legacy membership', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO events VALUES ('legacy-event', 'Administrator Edited Event', 'Legacy Theme', '2026-12-01', 'Legacy Venue', '2026-10-31', 'Legacy Contact');
      INSERT INTO projects VALUES ('legacy-project', 'legacy-event', 'Administrator Edited Project', 'individual', 'legacy');
      INSERT INTO registrations VALUES ('RLEGACY', 'legacy-event', 'legacy', 'ULEGACY', 'OLEGACY', 'Legacy Org', '{"name":"Legacy Athlete"}', 'legacy-key', '小学低段', 'legacy-project', 'Administrator Edited Project', 'individual', '', 'approved', '', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      INSERT INTO results VALUES ('RLEGACY', '一等奖', '1', '99', '2026-01-03T00:00:00.000Z');
      INSERT INTO certificates VALUES ('CLEGACY', 'RLEGACY', 'ULEGACY', 'OLEGACY', 'LEGACY-001', 1, 'legacy.pdf', 'legacy.pdf', '/legacy.pdf', '一等奖', '1', '99', 'published', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
    `);

    await store.initialize();
    await pool.query(`
      INSERT INTO certificates
        (id, registration_id, slot, title, file_name, stored_name, file_path, source, uploaded_at)
      VALUES ('CLEGACY-DEFAULT-STATUS', 'RLEGACY', 2, '迁移后默认状态', 'default.pdf', 'default.pdf', '/default.pdf', 'manual', NOW())
    `);
    const defaultStatus = await pool.query("SELECT status FROM certificates WHERE id = 'CLEGACY-DEFAULT-STATUS'");
    assert.equal(defaultStatus.rows[0].status, "draft");
    await assert.rejects(pool.query(`
      INSERT INTO certificates
        (id, registration_id, slot, title, file_name, stored_name, file_path, status, source, uploaded_at)
      VALUES ('CLEGACY-INVALID-SLOT', 'RLEGACY', 3, '迁移后非法槽位', 'invalid.pdf', 'invalid.pdf', '/invalid.pdf', 'draft', 'manual', NOW())
    `), /check/i);

    const data = await store.readDb();
    const legacyEvent = data.events.find((event) => event.id === "legacy-event");
    const legacyProject = data.projects.find((project) => project.id === "legacy-project");
    const legacyRegistration = data.registrations.find((registration) => registration.id === "RLEGACY");
    const legacyCertificate = data.certificates.find((certificate) => certificate.id === "CLEGACY");

    assert.equal(data.users.some((user) => user.id === "ULEGACY"), true);
    assert.equal(data.organizations.some((organization) => organization.id === "OLEGACY"), true);
    assert.equal(data.memberships.some((membership) => membership.id === "MLEGACY"), true);
    assert.equal(legacyEvent.name, "Administrator Edited Event");
    assert.equal(legacyProject.name, "Administrator Edited Project");
    assert.equal(legacyProject.allowedGroups.length, 4);
    assert.equal(legacyRegistration.eventId, "legacy-event");
    assert.equal(legacyRegistration.awardName, "一等奖");
    assert.equal(legacyCertificate.slot, 1);
    assert.equal(legacyCertificate.title, "获奖证书");
    assert.equal(data.events.filter((event) => event.isCurrent).length, 1);

    await pool.query("ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_organization_id_fk");
    await pool.query("DELETE FROM memberships WHERE organization_id = 'OLEGACY'");
    await pool.query("DELETE FROM organizations WHERE id = 'OLEGACY'");
    const snapshot = await pool.query("SELECT organization_id, organization_name FROM registrations WHERE id = 'RLEGACY'");
    assert.deepEqual(snapshot.rows[0], { organization_id: null, organization_name: "Legacy Org" });
  } finally {
    await store.close();
  }
});
