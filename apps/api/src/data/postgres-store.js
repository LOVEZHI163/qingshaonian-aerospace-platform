import fs from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";

import { APPROVED_GROUP_NAMES, ensureDbShape, EVENT, normalizeSubmissionWarnings, PROJECTS, seedDb } from "./seed.js";
import { createPostgresAuthState } from "./auth-state.js";

const schemaUrl = new URL("./schema.sql", import.meta.url);
const migrationsUrl = new URL("./migrations/", import.meta.url);
const ADVISORY_LOCK_KEY = 72451029;
let postgresFallbackTail = Promise.resolve();

function isPgMemUnsupportedAdvisoryLock(error) {
  return /function pg_advisory_lock\([^)]*\) does not exist/i.test(String(error?.data?.error || ""))
    && /pg-mem implements very few native functions/i.test(String(error?.data?.hint || ""));
}

async function acquireFallbackLock() {
  let unlock;
  const previous = postgresFallbackTail;
  postgresFallbackTail = new Promise((resolve) => { unlock = resolve; });
  await previous;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    unlock();
  };
}

function iso(value) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function shanghaiDate(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

async function deleteMissing(client, table, key, ids) {
  const keep = new Set(ids);
  const existing = await client.query(`SELECT ${key} AS id FROM ${table}`);
  for (const row of existing.rows) {
    if (!keep.has(row.id)) await client.query(`DELETE FROM ${table} WHERE ${key} = $1`, [row.id]);
  }
}

async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT
      )
    `);
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS schema_migrations_name_key ON schema_migrations(name)");
    const names = (await fs.readdir(migrationsUrl))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    let supportsPlpgsql = true;
    try {
      await client.query("DO $$ BEGIN END $$;");
    } catch {
      supportsPlpgsql = false;
    }
    for (const name of names) {
      const applied = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
      if (applied.rowCount > 0) continue;

      let migration = await fs.readFile(new URL(name, migrationsUrl), "utf8");
      if (name === "007-multi-event-accounts.sql") {
        migration = migration.replace(
          "CREATE INDEX registrations_personal_user_id_idx",
          "CREATE INDEX IF NOT EXISTS registrations_personal_user_id_idx"
        );
        const registrationColumns = await client.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'registrations' AND column_name = 'created_by_user_id'
        `);
        if (registrationColumns.rowCount > 0) {
          migration = "";
        } else {
          const participationTable = await client.query(`
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'organization_event_participations'
          `);
          if (participationTable.rowCount > 0) {
            migration = migration
              .replace(/CREATE TABLE organization_event_participations \([\s\S]*?\);\s*/, "")
              .replace(/CREATE INDEX organization_event_participations_event_id_idx\s+ON organization_event_participations\(event_id\);\s*/, "");
          }
        }
      }
      if (name === "008-image-video-submissions.sql") {
        const projectMode = await client.query(`
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'projects' AND column_name = 'submission_mode'
        `);
        const [sessions, assets] = await Promise.all([
          client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'registration_upload_sessions'`),
          client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'registration_submission_assets'`)
        ]);
        if (projectMode.rowCount > 0) {
          migration = migration.replace(/ALTER TABLE projects[\s\S]*?;\s*/, "");
        }
        if (sessions.rowCount > 0) {
          migration = migration
            .replace(/CREATE TABLE registration_upload_sessions \([\s\S]*?\);\s*/, "")
            .replace(/CREATE INDEX registration_upload_sessions_owner_expires_at_idx[\s\S]*?;\s*/, "");
        }
        if (assets.rowCount > 0) {
          migration = migration
            .replace(/CREATE TABLE registration_submission_assets \([\s\S]*?\);\s*/, "")
            .replace(/CREATE INDEX registration_submission_assets_registration_id_idx[\s\S]*?;\s*/, "")
            .replace(/CREATE INDEX registration_submission_assets_upload_session_id_idx[\s\S]*?;\s*/, "");
        }
      }
      if (name === "009-admin-submission-session-channel.sql") {
        const sessionChannel = await client.query(`
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'registration_upload_sessions' AND column_name = 'channel'
        `);
        if (sessionChannel.rowCount > 0) migration = "";
      }
      if (name === "010-submission-asset-warnings.sql") {
        const assetWarnings = await client.query(`
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'registration_submission_assets' AND column_name = 'warnings'
        `);
        if (assetWarnings.rowCount > 0) migration = "";
      }
      for (const tableName of ["site_settings", "event_public_profiles", "content_posts", "media_assets", "content_attachments"]) {
        const existing = await client.query(`
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = $1
        `, [tableName]);
        if (existing.rowCount > 0) {
          migration = migration.replace(new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\([\\s\\S]*?\\);\\s*`), "");
        }
      }
      const projectGroups = await client.query(`
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'project_groups'
      `);
      if (projectGroups.rowCount > 0) {
        migration = migration.replace(/CREATE TABLE IF NOT EXISTS project_groups \([\s\S]*?\);\s*/, "");
      }
      const organizationDocuments = await client.query(`
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'organization_documents'
      `);
      if (organizationDocuments.rowCount > 0) {
        migration = migration.replace(/CREATE TABLE IF NOT EXISTS organization_documents \([\s\S]*?\);\s*/, "");
      } else {
        migration = migration.replace("CREATE TABLE IF NOT EXISTS organization_documents", "CREATE TABLE organization_documents");
      }
      const auditLogs = await client.query(`
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'audit_logs'
      `);
      if (auditLogs.rowCount > 0) {
        migration = migration.replace(/CREATE TABLE IF NOT EXISTS audit_logs \([\s\S]*?\);\s*/, "");
      } else {
        migration = migration.replace("CREATE TABLE IF NOT EXISTS audit_logs", "CREATE TABLE audit_logs");
      }
      for (const tableName of ["auth_rate_buckets", "password_reset_challenges", "file_cleanup_journal", "certificate_import_batches", "certificate_import_errors"]) {
        const existing = await client.query(`
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = $1
        `, [tableName]);
        if (existing.rowCount > 0) {
          migration = migration.replace(new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\([\\s\\S]*?\\);\\s*`), "");
        }
      }
      if (!supportsPlpgsql) {
        migration = migration.replace(/DO \$\$[\s\S]*?END \$\$;/g, "");
        if (name === "007-multi-event-accounts.sql") {
          migration = migration.replace(
            /UPDATE registrations r[\s\S]*?WHERE u\.id = r\.user_id;\s*/,
            `UPDATE registrations SET created_by_user_id = user_id;
             UPDATE registrations SET personal_user_id = user_id
             WHERE user_id IN (SELECT id FROM users WHERE type = 'ordinary');
             UPDATE registrations SET created_via = CASE
               WHEN user_id IN (SELECT id FROM users WHERE type = 'organization') THEN 'organization'
               ELSE 'personal'
             END;\n`
          );
        }
      }

      await client.query("BEGIN");
      try {
        if (migration.trim()) await client.query(migration);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

async function runSchema(pool) {
  let schema = await fs.readFile(schemaUrl, "utf8");
  const tableRows = await pool.query(`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `);
  for (const { table_name: tableName } of tableRows.rows) {
    schema = schema.replace(new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\([\\s\\S]*?\\);\\s*`, "g"), "");
    if (tableName === "registrations") {
      schema = schema.replace(/CREATE INDEX IF NOT EXISTS registrations_personal_user_id_idx ON registrations\(personal_user_id\);\s*/, "");
    }
  }
  await pool.query(schema);
}

async function addApprovedGroups(pool) {
  const [projects, existingGroups] = await Promise.all([
    pool.query("SELECT id FROM projects"),
    pool.query("SELECT DISTINCT project_id FROM project_groups")
  ]);
  const projectsWithGroups = new Set(existingGroups.rows.map((row) => row.project_id));
  for (const project of projects.rows) {
    if (projectsWithGroups.has(project.id)) continue;
    for (const groupName of APPROVED_GROUP_NAMES) {
      await pool.query(
        `INSERT INTO project_groups (project_id, group_name)
         VALUES ($1, $2)
         ON CONFLICT (project_id, group_name) DO NOTHING`,
        [project.id, groupName]
      );
    }
  }
}

async function backfillCurrentDocumentIds(pool) {
  const [organizations, documents] = await Promise.all([
    pool.query("SELECT id, current_document_id FROM organizations"),
    pool.query("SELECT id, organization_id, uploaded_at FROM organization_documents WHERE cleaned_at IS NULL")
  ]);
  const currentByOrganization = new Map();
  for (const document of documents.rows) {
    const current = currentByOrganization.get(document.organization_id);
    const documentTime = new Date(document.uploaded_at).getTime();
    const currentTime = current ? new Date(current.uploaded_at).getTime() : Number.NEGATIVE_INFINITY;
    if (!current || documentTime > currentTime || (documentTime === currentTime && document.id.localeCompare(current.id) > 0)) {
      currentByOrganization.set(document.organization_id, document);
    }
  }
  for (const organization of organizations.rows) {
    if (organization.current_document_id) continue;
    const current = currentByOrganization.get(organization.id);
    if (current) await pool.query("UPDATE organizations SET current_document_id = $1 WHERE id = $2 AND current_document_id IS NULL", [current.id, organization.id]);
  }
}

export function createPostgresStore(pool, { seedOnEmpty = true } = {}) {
  const mutationContext = new AsyncLocalStorage();
  let mutationTail = Promise.resolve();

  async function acquireQueueSlot() {
    let unlock;
    const previous = mutationTail;
    mutationTail = new Promise((resolve) => { unlock = resolve; });
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      unlock();
    };
  }

  async function acquireMutationClient() {
    const releaseQueue = await acquireQueueSlot();
    let client;
    try {
      client = await pool.connect();
      await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    } catch (error) {
      client?.release();
      if (!isPgMemUnsupportedAdvisoryLock(error)) {
        releaseQueue();
        throw error;
      }
      const releaseFallback = await acquireFallbackLock();
      return {
        client: null,
        async release() {
          try { await releaseFallback(); } finally { releaseQueue(); }
        }
      };
    }

    let released = false;
    return {
      client,
      async release() {
        if (released) return;
        released = true;
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
        } finally {
          client.release();
          releaseQueue();
        }
      }
    };
  }

  function activeContext() {
    const context = mutationContext.getStore();
    if (context && !context.active) throw new Error("Mutation lock context has already been released");
    return context;
  }

  const store = {
    kind: "postgres",
    authState: createPostgresAuthState(pool),
    async withMutationLock(handler) {
      const existing = activeContext();
      if (existing) return handler();
      const lock = await acquireMutationClient();
      const context = { client: lock.client, active: true };
      try {
        return await mutationContext.run(context, handler);
      } finally {
        context.active = false;
        await lock.release();
      }
    },
    async initialize() {
      await runSchema(pool);
      await runMigrations(pool);
      await backfillCurrentDocumentIds(pool);
      await addApprovedGroups(pool);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const existingEvent = await client.query("SELECT id FROM events WHERE id = $1", [EVENT.id]);
        if (existingEvent.rowCount === 0) {
          await client.query(
            `INSERT INTO events
              (id, name, theme, date_label, venue, registration_deadline, contact,
               registration_start_at, registration_end_at, registration_mode, status, is_current,
               archived_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [
              EVENT.id, EVENT.name, EVENT.theme, EVENT.date, EVENT.venue, EVENT.registrationDeadline, EVENT.contact,
              EVENT.registrationStartAt, EVENT.registrationEndAt, EVENT.registrationMode, EVENT.status, EVENT.isCurrent,
              EVENT.archivedAt, EVENT.createdAt, EVENT.updatedAt
            ]
          );
        }
        const insertedProjectIds = new Set();
        for (const project of PROJECTS) {
          const existingProject = await client.query("SELECT 1 FROM projects WHERE id = $1", [project.id]);
          if (existingProject.rowCount > 0) continue;
          const inserted = await client.query(
            `INSERT INTO projects
              (id, event_id, name, type, category, enabled, instructor_required, display_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO NOTHING`,
            [project.id, project.eventId || EVENT.id, project.name, project.type, project.category, project.enabled, project.instructorRequired, project.displayOrder]
          );
          if (inserted.rowCount > 0) insertedProjectIds.add(project.id);
        }
        for (const project of PROJECTS.filter((row) => insertedProjectIds.has(row.id))) {
          for (const groupName of project.allowedGroups) {
            await client.query(
              `INSERT INTO project_groups (project_id, group_name)
               VALUES ($1, $2)
               ON CONFLICT (project_id, group_name) DO NOTHING`,
              [project.id, groupName]
            );
          }
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const count = await pool.query("SELECT COUNT(*)::integer AS count FROM users");
      if (seedOnEmpty && count.rows[0].count === 0) {
        const initialDb = structuredClone(seedDb);
        initialDb.siteSettings = (await store.readDb()).siteSettings;
        await store.writeDb(initialDb);
      }
    },
    async readDb() {
      const executor = activeContext()?.client || pool;
      const [events, projects, projectGroups, users, organizations, memberships, organizationEventParticipations, registrations, certificates, certificateImportBatches, certificateImportErrors, organizationDocuments, fileCleanupJournal, auditLogs, siteSettings, eventPublicProfiles, contentPosts, mediaAssets, contentAttachments, registrationUploadSessions, registrationSubmissionAssets] = await Promise.all([
        executor.query("SELECT * FROM events ORDER BY created_at, id"),
        executor.query("SELECT * FROM projects ORDER BY display_order, id"),
        executor.query("SELECT * FROM project_groups ORDER BY project_id, group_name"),
        executor.query("SELECT * FROM users ORDER BY created_at, id"),
        executor.query("SELECT * FROM organizations ORDER BY created_at, id"),
        executor.query("SELECT * FROM memberships ORDER BY created_at, id"),
        executor.query("SELECT * FROM organization_event_participations ORDER BY organization_id, event_id"),
        executor.query(`
          SELECT r.*, x.award_name, x.rank, x.score, x.recorded_at
          FROM registrations r
          LEFT JOIN results x ON x.registration_id = r.id
          ORDER BY r.created_at, r.id
        `),
        executor.query("SELECT * FROM certificates ORDER BY uploaded_at DESC, id"),
        executor.query("SELECT * FROM certificate_import_batches ORDER BY created_at, id"),
        executor.query("SELECT * FROM certificate_import_errors ORDER BY batch_id, row_number, id"),
        executor.query("SELECT * FROM organization_documents ORDER BY uploaded_at DESC, id"),
        executor.query("SELECT * FROM file_cleanup_journal ORDER BY created_at, id"),
        executor.query("SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC"),
        executor.query("SELECT * FROM site_settings WHERE id = 'default'"),
        executor.query("SELECT * FROM event_public_profiles ORDER BY display_order, event_id"),
        executor.query("SELECT * FROM content_posts ORDER BY sort_order, created_at, id"),
        executor.query("SELECT * FROM media_assets ORDER BY created_at, id"),
        executor.query("SELECT * FROM content_attachments ORDER BY content_id, display_order, media_id"),
        executor.query("SELECT * FROM registration_upload_sessions ORDER BY created_at, id"),
        executor.query("SELECT * FROM registration_submission_assets ORDER BY uploaded_at, id")
      ]);

      const groupsByProject = projectGroups.rows.reduce((groups, row) => {
        (groups[row.project_id] ||= []).push(row);
        return groups;
      }, {});

      return ensureDbShape({
        events: events.rows.map((row) => ({
          id: row.id,
          name: row.name,
          theme: row.theme,
          dateLabel: row.date_label,
          venue: row.venue,
          registrationDeadline: row.registration_deadline,
          contact: row.contact,
          registrationStartAt: iso(row.registration_start_at),
          registrationEndAt: iso(row.registration_end_at),
          registrationMode: row.registration_mode,
          status: row.status,
          isCurrent: row.is_current,
          archivedAt: row.archived_at ? iso(row.archived_at) : null,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at)
        })),
        projects: projects.rows.map((row) => ({
          id: row.id,
          eventId: row.event_id,
          name: row.name,
          type: row.type,
          category: row.category,
          enabled: row.enabled,
          instructorRequired: row.instructor_required,
          displayOrder: row.display_order,
          submissionMode: row.submission_mode,
          allowedGroups: (groupsByProject[row.id] || []).map((group) => group.group_name)
        })),
        projectGroups: projectGroups.rows.map((row) => ({
          projectId: row.project_id,
          groupName: row.group_name
        })),
        users: users.rows.map((row) => ({
          id: row.id,
          name: row.name,
          phone: row.phone,
          password: row.password,
          type: row.type,
          status: row.status,
          sessionVersion: row.session_version,
          mustChangePassword: row.must_change_password,
          temporaryPasswordCiphertext: row.temporary_password_ciphertext,
          temporaryPasswordIv: row.temporary_password_iv,
          temporaryPasswordTag: row.temporary_password_tag,
          temporaryPasswordCreatedAt: row.temporary_password_created_at ? iso(row.temporary_password_created_at) : null,
          createdAt: iso(row.created_at)
        })),
        organizations: organizations.rows.map((row) => ({
          id: row.id,
          name: row.name,
          code: row.code,
          ownerUserId: row.owner_user_id,
          contactName: row.contact_name,
          contactPhone: row.contact_phone,
          status: row.status,
          createdAt: iso(row.created_at),
          creditCode: row.credit_code,
          reviewStatus: row.review_status,
          rejectReason: row.reject_reason,
          reviewedBy: row.reviewed_by,
          reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : null,
          updatedAt: iso(row.updated_at),
          currentDocumentId: row.current_document_id || null
        })),
        memberships: memberships.rows.map((row) => ({
          id: row.id,
          userId: row.user_id,
          ...(row.invited_phone ? { invitedPhone: row.invited_phone } : {}),
          ...(row.invited_name ? { invitedName: row.invited_name } : {}),
          organizationId: row.organization_id,
          role: row.role,
          status: row.status,
          direction: row.direction,
          note: row.note,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at)
        })),
        organizationEventParticipations: organizationEventParticipations.rows.map((row) => ({
          organizationId: row.organization_id,
          eventId: row.event_id,
          joinedByUserId: row.joined_by_user_id,
          joinedAt: iso(row.joined_at)
        })),
        registrations: registrations.rows.map((row) => ({
          id: row.id,
          eventId: row.event_id,
          source: row.source,
          createdByUserId: row.created_by_user_id,
          personalUserId: row.personal_user_id,
          organizationId: row.organization_id,
          createdVia: row.created_via,
          organization: row.organization_name,
          organizationDeleted: Boolean(row.organization_deleted),
          athlete: row.athlete,
          athleteKey: row.athlete_key,
          group: row.group_name,
          projectId: row.project_id,
          projectName: row.project_name,
          projectType: row.project_type,
          instructor: row.instructor,
          status: row.status,
          rejectReason: row.reject_reason,
          awardName: row.award_name || "",
          rank: row.rank || "",
          score: row.score || "",
          resultRecordedAt: iso(row.recorded_at),
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at)
        })),
        certificates: certificates.rows.map((row) => ({
          id: row.id,
          registrationId: row.registration_id,
          slot: row.slot,
          title: row.title,
          fileName: row.file_name,
          storedName: row.stored_name,
          filePath: row.file_path,
          awardName: row.award_name,
          rank: row.rank,
          score: row.score,
          status: row.status,
          source: row.source,
          importBatchId: row.import_batch_id,
          uploadedAt: iso(row.uploaded_at),
          publishedAt: iso(row.published_at),
          cleanedAt: iso(row.cleaned_at)
        })),
        certificateImportBatches: certificateImportBatches.rows.map((row) => ({
          id: row.id,
          eventId: row.event_id,
          createdBy: row.created_by,
          originalName: row.original_name,
          status: row.status,
          previewJson: row.preview_json || [],
          validCount: row.valid_count,
          errorCount: row.error_count,
          replaceCount: row.replace_count,
          createdAt: iso(row.created_at),
          committedAt: iso(row.committed_at)
        })),
        certificateImportErrors: certificateImportErrors.rows.map((row) => ({
          id: row.id,
          batchId: row.batch_id,
          rowNumber: row.row_number,
          registrationId: row.registration_id,
          message: row.message
        })),
        organizationDocuments: organizationDocuments.rows.map((row) => ({
          id: row.id,
          organizationId: row.organization_id,
          documentType: row.document_type,
          originalName: row.original_name,
          storedName: row.stored_name,
          filePath: row.file_path,
          mimeType: row.mime_type,
          sizeBytes: Number(row.size_bytes),
          uploadedAt: iso(row.uploaded_at),
          cleanedAt: row.cleaned_at ? iso(row.cleaned_at) : null
        })),
        fileCleanupJournal: fileCleanupJournal.rows.map((row) => ({ id: row.id, filePath: row.file_path, category: row.category, attempts: row.attempts, lastError: row.last_error, createdAt: iso(row.created_at), lastAttemptAt: iso(row.last_attempt_at) })),
        auditLogs: auditLogs.rows.map((row) => ({
          id: row.id,
          actorUserId: row.actor_user_id,
          actorName: row.actor_name,
          action: row.action,
          targetType: row.target_type,
          targetId: row.target_id,
          summary: row.summary,
          createdAt: iso(row.created_at)
        })),
        siteSettings: siteSettings.rows[0] && {
          id: siteSettings.rows[0].id,
          platformName: siteSettings.rows[0].platform_name,
          featuredEventId: siteSettings.rows[0].featured_event_id,
          platformIntro: siteSettings.rows[0].platform_intro,
          organizers: siteSettings.rows[0].organizers || [],
          contact: siteSettings.rows[0].contact,
          icp: siteSettings.rows[0].icp,
          seoTitle: siteSettings.rows[0].seo_title,
          seoDescription: siteSettings.rows[0].seo_description,
          defaultHeroMediaId: siteSettings.rows[0].default_hero_media_id,
          shareMediaId: siteSettings.rows[0].share_media_id,
          version: siteSettings.rows[0].version
        },
        eventPublicProfiles: eventPublicProfiles.rows.map((row) => ({
          eventId: row.event_id,
          slug: row.slug,
          slogan: row.slogan,
          summary: row.summary,
          isVisible: row.is_visible,
          displayOrder: row.display_order,
          heroMediaId: row.hero_media_id,
          version: row.version,
          updatedAt: iso(row.updated_at)
        })),
        contentPosts: contentPosts.rows.map((row) => ({
          id: row.id,
          slug: row.slug,
          eventId: row.event_id,
          type: row.type,
          title: row.title,
          summary: row.summary,
          bodyHtml: row.body_html,
          status: row.status,
          publishAt: row.publish_at ? iso(row.publish_at) : null,
          pinned: row.pinned,
          sortOrder: row.sort_order,
          coverMediaId: row.cover_media_id,
          version: row.version,
          createdBy: row.created_by,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at)
        })),
        mediaAssets: mediaAssets.rows.map((row) => ({
          id: row.id,
          eventId: row.event_id,
          purpose: row.purpose,
          visibility: row.visibility,
          originalName: row.original_name,
          storedName: row.stored_name,
          filePath: row.file_path,
          mimeType: row.mime_type,
          sizeBytes: Number(row.size_bytes),
          width: row.width,
          height: row.height,
          variants: row.variants || {},
          createdBy: row.created_by,
          createdAt: iso(row.created_at),
          cleanedAt: row.cleaned_at ? iso(row.cleaned_at) : null
        })),
        contentAttachments: contentAttachments.rows.map((row) => ({
          contentId: row.content_id,
          mediaId: row.media_id,
          label: row.label,
          displayOrder: row.display_order
        })),
        registrationUploadSessions: registrationUploadSessions.rows.map((row) => ({
          id: row.id,
          eventId: row.event_id,
          projectId: row.project_id,
          ownerUserId: row.owner_user_id,
          organizationId: row.organization_id,
          channel: row.channel,
          state: row.state,
          createdAt: iso(row.created_at),
          expiresAt: iso(row.expires_at),
          committedAt: row.committed_at ? iso(row.committed_at) : null
        })),
        registrationSubmissionAssets: registrationSubmissionAssets.rows.map((row) => ({
          id: row.id,
          registrationId: row.registration_id,
          uploadSessionId: row.upload_session_id,
          kind: row.kind,
          originalName: row.original_name,
          storedName: row.stored_name,
          filePath: row.file_path,
          mimeType: row.mime_type,
          sizeBytes: Number(row.size_bytes),
          width: row.width,
          height: row.height,
          durationMs: row.duration_ms,
          warnings: normalizeSubmissionWarnings(row.warnings),
          uploadedByUserId: row.uploaded_by_user_id,
          uploadedAt: iso(row.uploaded_at),
          cleanedAt: row.cleaned_at ? iso(row.cleaned_at) : null,
          cleanupReason: row.cleanup_reason
        }))
      });
    },
    async writeDb(input) {
      const db = ensureDbShape(structuredClone(input));
      const context = activeContext();
      const client = context?.client || await pool.connect();
      const ownsClient = !context?.client;
      try {
        await client.query("BEGIN");

        if (db.events.some((row) => row.isCurrent)) {
          await client.query("UPDATE events SET is_current = FALSE WHERE is_current = TRUE");
        }

        for (const row of db.events) {
          await client.query(
            `INSERT INTO events
              (id, name, theme, date_label, venue, registration_deadline, contact,
               registration_start_at, registration_end_at, registration_mode, status, is_current,
               archived_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT (id) DO UPDATE SET
               name = EXCLUDED.name,
               theme = EXCLUDED.theme,
               date_label = EXCLUDED.date_label,
               venue = EXCLUDED.venue,
               registration_deadline = EXCLUDED.registration_deadline,
               contact = EXCLUDED.contact,
               registration_start_at = EXCLUDED.registration_start_at,
               registration_end_at = EXCLUDED.registration_end_at,
               registration_mode = EXCLUDED.registration_mode,
               status = EXCLUDED.status,
               is_current = EXCLUDED.is_current,
               archived_at = EXCLUDED.archived_at,
               created_at = EXCLUDED.created_at,
               updated_at = EXCLUDED.updated_at`,
            [
              row.id, row.name, row.theme, row.dateLabel, row.venue,
              shanghaiDate(row.registrationEndAt), row.contact,
              row.registrationStartAt, row.registrationEndAt, row.registrationMode, row.status, row.isCurrent,
              row.archivedAt, row.createdAt, row.updatedAt
            ]
          );
        }

        for (const row of db.projects) {
          await client.query(
            `INSERT INTO projects
              (id, event_id, name, type, category, enabled, instructor_required, display_order, submission_mode)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET
               event_id = EXCLUDED.event_id,
               name = EXCLUDED.name,
               type = EXCLUDED.type,
               category = EXCLUDED.category,
               enabled = EXCLUDED.enabled,
               instructor_required = EXCLUDED.instructor_required,
               display_order = EXCLUDED.display_order,
               submission_mode = EXCLUDED.submission_mode`,
            [row.id, row.eventId, row.name, row.type, row.category, row.enabled, row.instructorRequired, row.displayOrder, row.submissionMode]
          );
        }

        await client.query("DELETE FROM project_groups");
        for (const row of db.projectGroups) {
          await client.query(
            "INSERT INTO project_groups (project_id, group_name) VALUES ($1, $2)",
            [row.projectId, row.groupName]
          );
        }

        for (const row of db.users) {
          await client.query(
            `INSERT INTO users
              (id, name, phone, password, type, status, session_version, must_change_password,
               temporary_password_ciphertext, temporary_password_iv, temporary_password_tag, temporary_password_created_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (id) DO UPDATE SET
               name = EXCLUDED.name,
               phone = EXCLUDED.phone,
               password = EXCLUDED.password,
               type = EXCLUDED.type,
               status = EXCLUDED.status,
               session_version = EXCLUDED.session_version,
               must_change_password = EXCLUDED.must_change_password,
               temporary_password_ciphertext = EXCLUDED.temporary_password_ciphertext,
               temporary_password_iv = EXCLUDED.temporary_password_iv,
               temporary_password_tag = EXCLUDED.temporary_password_tag,
               temporary_password_created_at = EXCLUDED.temporary_password_created_at,
               created_at = EXCLUDED.created_at`,
            [
              row.id, row.name, row.phone, row.password, row.type, row.status, row.sessionVersion, row.mustChangePassword,
              row.temporaryPasswordCiphertext, row.temporaryPasswordIv, row.temporaryPasswordTag, row.temporaryPasswordCreatedAt, row.createdAt
            ]
          );
        }

        for (const row of db.organizations) {
          await client.query(
            `INSERT INTO organizations
              (id, name, code, owner_user_id, contact_name, contact_phone, status, created_at,
               credit_code, review_status, reject_reason, reviewed_by, reviewed_at, updated_at, current_document_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT (id) DO UPDATE SET
               name = EXCLUDED.name,
               code = EXCLUDED.code,
               owner_user_id = EXCLUDED.owner_user_id,
               contact_name = EXCLUDED.contact_name,
               contact_phone = EXCLUDED.contact_phone,
               status = EXCLUDED.status,
               created_at = EXCLUDED.created_at,
               credit_code = EXCLUDED.credit_code,
               review_status = EXCLUDED.review_status,
               reject_reason = EXCLUDED.reject_reason,
               reviewed_by = EXCLUDED.reviewed_by,
               reviewed_at = EXCLUDED.reviewed_at,
               updated_at = EXCLUDED.updated_at,
               current_document_id = EXCLUDED.current_document_id`,
            [
              row.id, row.name, row.code, row.ownerUserId, row.contactName || "", row.contactPhone || "", row.status, row.createdAt,
              row.creditCode, row.reviewStatus, row.rejectReason || "", row.reviewedBy || null, row.reviewedAt || null, row.updatedAt, row.currentDocumentId || null
            ]
          );
        }

        for (const row of db.auditLogs || []) {
          await client.query(
            `INSERT INTO audit_logs
              (id, actor_user_id, actor_name, action, target_type, target_id, summary, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO UPDATE SET
               actor_user_id = EXCLUDED.actor_user_id,
               actor_name = EXCLUDED.actor_name,
               action = EXCLUDED.action,
               target_type = EXCLUDED.target_type,
               target_id = EXCLUDED.target_id,
               summary = EXCLUDED.summary,
               created_at = EXCLUDED.created_at`,
            [row.id, row.actorUserId || null, row.actorName, row.action, row.targetType, row.targetId, row.summary, row.createdAt]
          );
        }

        for (const row of db.organizationDocuments) {
          await client.query(
            `INSERT INTO organization_documents
              (id, organization_id, document_type, original_name, stored_name, file_path, mime_type, size_bytes, uploaded_at, cleaned_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (id) DO UPDATE SET
               organization_id = EXCLUDED.organization_id,
               document_type = EXCLUDED.document_type,
               original_name = EXCLUDED.original_name,
               stored_name = EXCLUDED.stored_name,
               file_path = EXCLUDED.file_path,
               mime_type = EXCLUDED.mime_type,
               size_bytes = EXCLUDED.size_bytes,
               uploaded_at = EXCLUDED.uploaded_at,
               cleaned_at = EXCLUDED.cleaned_at`,
            [
              row.id, row.organizationId, row.documentType, row.originalName, row.storedName, row.filePath,
              row.mimeType, row.sizeBytes, row.uploadedAt, row.cleanedAt || null
            ]
          );
        }

        for (const row of db.fileCleanupJournal || []) {
          await client.query(
            `INSERT INTO file_cleanup_journal (id, file_path, category, attempts, last_error, created_at, last_attempt_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET file_path = EXCLUDED.file_path, category = EXCLUDED.category, attempts = EXCLUDED.attempts, last_error = EXCLUDED.last_error, created_at = EXCLUDED.created_at, last_attempt_at = EXCLUDED.last_attempt_at`,
            [row.id, row.filePath, row.category, row.attempts, row.lastError, row.createdAt, row.lastAttemptAt || row.createdAt]
          );
        }

        for (const row of db.memberships) {
          await client.query(
            `INSERT INTO memberships
              (id, user_id, invited_phone, invited_name, organization_id, role, status, direction, note, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (id) DO UPDATE SET
               user_id = EXCLUDED.user_id,
               invited_phone = EXCLUDED.invited_phone,
               invited_name = EXCLUDED.invited_name,
               organization_id = EXCLUDED.organization_id,
               role = EXCLUDED.role,
               status = EXCLUDED.status,
               direction = EXCLUDED.direction,
               note = EXCLUDED.note,
               created_at = EXCLUDED.created_at,
               updated_at = EXCLUDED.updated_at`,
            [row.id, row.userId || null, row.invitedPhone || null, row.invitedName || null, row.organizationId, row.role, row.status, row.direction, row.note || "", row.createdAt, row.updatedAt]
          );
        }

        for (const row of db.organizationEventParticipations) {
          await client.query(
            `INSERT INTO organization_event_participations
              (organization_id, event_id, joined_by_user_id, joined_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (organization_id, event_id) DO UPDATE SET
               joined_by_user_id = EXCLUDED.joined_by_user_id,
               joined_at = EXCLUDED.joined_at`,
            [row.organizationId, row.eventId, row.joinedByUserId, row.joinedAt]
          );
        }

        for (const row of db.registrations) {
          await client.query(
            `INSERT INTO registrations
              (id, event_id, source, created_by_user_id, personal_user_id, organization_id, created_via, organization_name, organization_deleted, athlete, athlete_key,
               group_name, project_id, project_name, project_type, instructor, status, reject_reason, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
             ON CONFLICT (id) DO UPDATE SET
               event_id = EXCLUDED.event_id,
               source = EXCLUDED.source,
               created_by_user_id = EXCLUDED.created_by_user_id,
               personal_user_id = EXCLUDED.personal_user_id,
               organization_id = EXCLUDED.organization_id,
               created_via = EXCLUDED.created_via,
               organization_name = EXCLUDED.organization_name,
               organization_deleted = EXCLUDED.organization_deleted,
               athlete = EXCLUDED.athlete,
               athlete_key = EXCLUDED.athlete_key,
               group_name = EXCLUDED.group_name,
               project_id = EXCLUDED.project_id,
               project_name = EXCLUDED.project_name,
               project_type = EXCLUDED.project_type,
               instructor = EXCLUDED.instructor,
               status = EXCLUDED.status,
               reject_reason = EXCLUDED.reject_reason,
               created_at = EXCLUDED.created_at,
               updated_at = EXCLUDED.updated_at`,
            [row.id, row.eventId || EVENT.id, row.source, row.createdByUserId || null, row.personalUserId || null, row.organizationId || null, row.createdVia, row.organization || "", Boolean(row.organizationDeleted), JSON.stringify(row.athlete || {}), row.athleteKey, row.group, row.projectId, row.projectName, row.projectType, row.instructor || "", row.status, row.rejectReason || "", row.createdAt, row.updatedAt]
          );

          const hasResult = Boolean(row.awardName || row.rank || row.score || row.resultRecordedAt);
          if (hasResult) {
            await client.query(
              `INSERT INTO results (registration_id, award_name, rank, score, recorded_at)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (registration_id) DO UPDATE SET
                 award_name = EXCLUDED.award_name,
                 rank = EXCLUDED.rank,
                 score = EXCLUDED.score,
                 recorded_at = EXCLUDED.recorded_at`,
              [row.id, row.awardName || "", row.rank || "", row.score || "", row.resultRecordedAt || null]
            );
          } else {
            await client.query("DELETE FROM results WHERE registration_id = $1", [row.id]);
          }
        }

        for (const row of db.registrationUploadSessions) {
          await client.query(
            `INSERT INTO registration_upload_sessions
              (id, event_id, project_id, owner_user_id, organization_id, channel, state, created_at, expires_at, committed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (id) DO UPDATE SET
               event_id = EXCLUDED.event_id,
               project_id = EXCLUDED.project_id,
               owner_user_id = EXCLUDED.owner_user_id,
               organization_id = EXCLUDED.organization_id,
               channel = EXCLUDED.channel,
               state = EXCLUDED.state,
               created_at = EXCLUDED.created_at,
               expires_at = EXCLUDED.expires_at,
               committed_at = EXCLUDED.committed_at`,
            [row.id, row.eventId, row.projectId, row.ownerUserId || null, row.organizationId || null, row.channel || (row.organizationId ? "organization" : "personal"), row.state, row.createdAt, row.expiresAt, row.committedAt || null]
          );
        }

        for (const row of db.registrationSubmissionAssets) {
          await client.query(
            `INSERT INTO registration_submission_assets
              (id, registration_id, upload_session_id, kind, original_name, stored_name, file_path, mime_type,
               size_bytes, width, height, duration_ms, warnings, uploaded_by_user_id, uploaded_at, cleaned_at, cleanup_reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17)
             ON CONFLICT (id) DO UPDATE SET
               registration_id = EXCLUDED.registration_id,
               upload_session_id = EXCLUDED.upload_session_id,
               kind = EXCLUDED.kind,
               original_name = EXCLUDED.original_name,
               stored_name = EXCLUDED.stored_name,
               file_path = EXCLUDED.file_path,
               mime_type = EXCLUDED.mime_type,
               size_bytes = EXCLUDED.size_bytes,
               width = EXCLUDED.width,
               height = EXCLUDED.height,
               duration_ms = EXCLUDED.duration_ms,
               warnings = EXCLUDED.warnings,
               uploaded_by_user_id = EXCLUDED.uploaded_by_user_id,
               uploaded_at = EXCLUDED.uploaded_at,
               cleaned_at = EXCLUDED.cleaned_at,
               cleanup_reason = EXCLUDED.cleanup_reason`,
            [
              row.id, row.registrationId || null, row.uploadSessionId, row.kind, row.originalName, row.storedName,
              row.filePath, row.mimeType, row.sizeBytes, row.width ?? null, row.height ?? null, row.durationMs ?? null,
              JSON.stringify(normalizeSubmissionWarnings(row.warnings)), row.uploadedByUserId || null, row.uploadedAt,
              row.cleanedAt || null, row.cleanupReason || ""
            ]
          );
        }

        for (const row of db.certificateImportBatches) {
          await client.query(
            `INSERT INTO certificate_import_batches
              (id, event_id, created_by, original_name, status, preview_json, valid_count, error_count, replace_count, created_at, committed_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
             ON CONFLICT (id) DO UPDATE SET
               event_id = EXCLUDED.event_id,
               created_by = EXCLUDED.created_by,
               original_name = EXCLUDED.original_name,
               status = EXCLUDED.status,
               preview_json = EXCLUDED.preview_json,
               valid_count = EXCLUDED.valid_count,
               error_count = EXCLUDED.error_count,
               replace_count = EXCLUDED.replace_count,
               created_at = EXCLUDED.created_at,
               committed_at = EXCLUDED.committed_at`,
            [row.id, row.eventId, row.createdBy || null, row.originalName, row.status, JSON.stringify(row.previewJson || []), row.validCount || 0, row.errorCount || 0, row.replaceCount || 0, row.createdAt, row.committedAt || null]
          );
        }

        for (const row of db.certificates) {
          await client.query(
            `INSERT INTO certificates
              (id, registration_id, slot, title, file_name, stored_name, file_path,
               award_name, rank, score, status, source, import_batch_id, uploaded_at, published_at, cleaned_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             ON CONFLICT (id) DO UPDATE SET
               registration_id = EXCLUDED.registration_id,
               slot = EXCLUDED.slot,
               title = EXCLUDED.title,
               file_name = EXCLUDED.file_name,
               stored_name = EXCLUDED.stored_name,
               file_path = EXCLUDED.file_path,
               award_name = EXCLUDED.award_name,
               rank = EXCLUDED.rank,
               score = EXCLUDED.score,
               status = EXCLUDED.status,
               source = EXCLUDED.source,
               import_batch_id = EXCLUDED.import_batch_id,
               uploaded_at = EXCLUDED.uploaded_at,
               published_at = EXCLUDED.published_at,
               cleaned_at = EXCLUDED.cleaned_at`,
            [row.id, row.registrationId, row.slot, row.title, row.fileName, row.storedName, row.filePath, row.awardName || "", row.rank || "", row.score || "", row.status, row.source, row.importBatchId || null, row.uploadedAt, row.publishedAt || null, row.cleanedAt || null]
          );
        }

        for (const row of db.certificateImportErrors) {
          await client.query(
            `INSERT INTO certificate_import_errors (id, batch_id, row_number, registration_id, message)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO UPDATE SET
               batch_id = EXCLUDED.batch_id,
               row_number = EXCLUDED.row_number,
               registration_id = EXCLUDED.registration_id,
               message = EXCLUDED.message`,
            [row.id, row.batchId, row.rowNumber, row.registrationId || null, row.message]
          );
        }

        for (const row of db.mediaAssets) {
          await client.query(
            `INSERT INTO media_assets
              (id, event_id, purpose, visibility, original_name, stored_name, file_path, mime_type,
               size_bytes, width, height, variants, created_by, created_at, cleaned_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15)
             ON CONFLICT (id) DO UPDATE SET
               event_id = EXCLUDED.event_id,
               purpose = EXCLUDED.purpose,
               visibility = EXCLUDED.visibility,
               original_name = EXCLUDED.original_name,
               stored_name = EXCLUDED.stored_name,
               file_path = EXCLUDED.file_path,
               mime_type = EXCLUDED.mime_type,
               size_bytes = EXCLUDED.size_bytes,
               width = EXCLUDED.width,
               height = EXCLUDED.height,
               variants = EXCLUDED.variants,
               created_by = EXCLUDED.created_by,
               created_at = EXCLUDED.created_at,
               cleaned_at = EXCLUDED.cleaned_at`,
            [
              row.id, row.eventId || null, row.purpose, row.visibility, row.originalName, row.storedName,
              row.filePath, row.mimeType, row.sizeBytes, row.width ?? null, row.height ?? null,
              JSON.stringify(row.variants || {}), row.createdBy || null, row.createdAt, row.cleanedAt || null
            ]
          );
        }

        for (const row of db.eventPublicProfiles) {
          const currentProfile = await client.query(
            "SELECT * FROM event_public_profiles WHERE event_id = $1",
            [row.eventId]
          );
          const existingProfile = currentProfile.rows[0];
          if (existingProfile && existingProfile.version !== row.version) {
            throw new Error("event_public_profiles version conflict");
          }
          const profileChanged = !existingProfile
            || existingProfile.slug !== row.slug
            || existingProfile.slogan !== (row.slogan || "")
            || existingProfile.summary !== (row.summary || "")
            || existingProfile.is_visible !== row.isVisible
            || existingProfile.display_order !== row.displayOrder
            || existingProfile.hero_media_id !== (row.heroMediaId || null);
          if (!existingProfile) {
            const inserted = await client.query(
              `INSERT INTO event_public_profiles
                (event_id, slug, slogan, summary, is_visible, display_order, hero_media_id, version, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (event_id) DO NOTHING
               RETURNING event_id`,
              [row.eventId, row.slug, row.slogan || "", row.summary || "", row.isVisible, row.displayOrder, row.heroMediaId || null, row.version, row.updatedAt]
            );
            if (inserted.rowCount === 0) throw new Error("event_public_profiles version conflict");
          } else if (profileChanged) {
            const updated = await client.query(
              `UPDATE event_public_profiles SET
                 slug = $2,
                 slogan = $3,
                 summary = $4,
                 is_visible = $5,
                 display_order = $6,
                 hero_media_id = $7,
                 version = version + 1,
                 updated_at = $8
               WHERE event_id = $1 AND version = $9
               RETURNING event_id`,
              [row.eventId, row.slug, row.slogan || "", row.summary || "", row.isVisible, row.displayOrder, row.heroMediaId || null, row.updatedAt, row.version]
            );
            if (updated.rowCount === 0) throw new Error("event_public_profiles version conflict");
          }
        }

        for (const row of db.contentPosts) {
          const currentPost = await client.query(
            "SELECT * FROM content_posts WHERE id = $1",
            [row.id]
          );
          const existingPost = currentPost.rows[0];
          if (existingPost && existingPost.version !== row.version) {
            throw new Error("content_posts version conflict");
          }
          const postChanged = !existingPost
            || existingPost.slug !== row.slug
            || existingPost.event_id !== (row.eventId || null)
            || existingPost.type !== row.type
            || existingPost.title !== row.title
            || existingPost.summary !== (row.summary || "")
            || existingPost.body_html !== (row.bodyHtml || "")
            || existingPost.status !== row.status
            || (existingPost.publish_at ? iso(existingPost.publish_at) : null) !== (row.publishAt || null)
            || existingPost.pinned !== row.pinned
            || existingPost.sort_order !== row.sortOrder
            || existingPost.cover_media_id !== (row.coverMediaId || null)
            || existingPost.created_by !== (row.createdBy || null)
            || iso(existingPost.created_at) !== iso(row.createdAt);
          if (!existingPost) {
            const inserted = await client.query(
              `INSERT INTO content_posts
                (id, slug, event_id, type, title, summary, body_html, status, publish_at, pinned, sort_order,
                 cover_media_id, version, created_by, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
               ON CONFLICT (id) DO NOTHING
               RETURNING id`,
              [row.id, row.slug, row.eventId || null, row.type, row.title, row.summary || "", row.bodyHtml || "", row.status, row.publishAt || null, row.pinned, row.sortOrder, row.coverMediaId || null, row.version, row.createdBy || null, row.createdAt, row.updatedAt]
            );
            if (inserted.rowCount === 0) throw new Error("content_posts version conflict");
          } else if (postChanged) {
            const updated = await client.query(
              `UPDATE content_posts SET
                 slug = $2,
                 event_id = $3,
                 type = $4,
                 title = $5,
                 summary = $6,
                 body_html = $7,
                 status = $8,
                 publish_at = $9,
                 pinned = $10,
                 sort_order = $11,
                 cover_media_id = $12,
                 created_by = $13,
                 created_at = $14,
                 updated_at = $15,
                 version = version + 1
               WHERE id = $1 AND version = $16
               RETURNING id`,
              [row.id, row.slug, row.eventId || null, row.type, row.title, row.summary || "", row.bodyHtml || "", row.status, row.publishAt || null, row.pinned, row.sortOrder, row.coverMediaId || null, row.createdBy || null, row.createdAt, row.updatedAt, row.version]
            );
            if (updated.rowCount === 0) throw new Error("content_posts version conflict");
          }
        }

        const currentSiteSettings = await client.query(
          "SELECT * FROM site_settings WHERE id = $1",
          [db.siteSettings.id]
        );
        if (currentSiteSettings.rowCount > 0 && currentSiteSettings.rows[0].version !== db.siteSettings.version) {
          throw new Error("site_settings version conflict");
        }
        const currentSettings = currentSiteSettings.rows[0];
        const siteSettingsChanged = Boolean(currentSettings) && (
          currentSettings.platform_name !== db.siteSettings.platformName
          || currentSettings.featured_event_id !== (db.siteSettings.featuredEventId || null)
          || currentSettings.platform_intro !== (db.siteSettings.platformIntro || "")
          || JSON.stringify(currentSettings.organizers || []) !== JSON.stringify(db.siteSettings.organizers || [])
          || currentSettings.contact !== (db.siteSettings.contact || "")
          || currentSettings.icp !== (db.siteSettings.icp || "")
          || currentSettings.seo_title !== db.siteSettings.seoTitle
          || currentSettings.seo_description !== (db.siteSettings.seoDescription || "")
          || currentSettings.default_hero_media_id !== (db.siteSettings.defaultHeroMediaId || null)
          || currentSettings.share_media_id !== (db.siteSettings.shareMediaId || null)
        );
        if (!currentSettings) {
          const inserted = await client.query(
            `INSERT INTO site_settings
              (id, platform_name, featured_event_id, platform_intro, organizers, contact, icp, seo_title,
               seo_description, default_hero_media_id, share_media_id, version)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (id) DO NOTHING
             RETURNING id`,
            [
              db.siteSettings.id, db.siteSettings.platformName, db.siteSettings.featuredEventId || null,
              db.siteSettings.platformIntro || "", JSON.stringify(db.siteSettings.organizers || []),
              db.siteSettings.contact || "", db.siteSettings.icp || "", db.siteSettings.seoTitle,
              db.siteSettings.seoDescription || "", db.siteSettings.defaultHeroMediaId || null,
              db.siteSettings.shareMediaId || null, db.siteSettings.version
            ]
          );
          if (inserted.rowCount === 0) throw new Error("site_settings version conflict");
        } else if (siteSettingsChanged) {
          const updated = await client.query(
            `UPDATE site_settings SET
               platform_name = $2,
               featured_event_id = $3,
               platform_intro = $4,
               organizers = $5::jsonb,
               contact = $6,
               icp = $7,
               seo_title = $8,
               seo_description = $9,
               default_hero_media_id = $10,
               share_media_id = $11,
               version = version + 1,
               updated_at = NOW()
             WHERE id = $1 AND version = $12
             RETURNING id`,
            [
              db.siteSettings.id, db.siteSettings.platformName, db.siteSettings.featuredEventId || null,
              db.siteSettings.platformIntro || "", JSON.stringify(db.siteSettings.organizers || []),
              db.siteSettings.contact || "", db.siteSettings.icp || "", db.siteSettings.seoTitle,
              db.siteSettings.seoDescription || "", db.siteSettings.defaultHeroMediaId || null,
              db.siteSettings.shareMediaId || null, db.siteSettings.version
            ]
          );
          if (updated.rowCount === 0) throw new Error("site_settings version conflict");
        }

        for (const row of db.contentAttachments) {
          await client.query(
            `INSERT INTO content_attachments (content_id, media_id, label, display_order)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (content_id, media_id) DO UPDATE SET
               label = EXCLUDED.label,
               display_order = EXCLUDED.display_order`,
            [row.contentId, row.mediaId, row.label || "", row.displayOrder]
          );
        }

        await deleteMissing(client, "content_attachments", "content_id || ':' || media_id", db.contentAttachments.map((row) => `${row.contentId}:${row.mediaId}`));
        await deleteMissing(client, "content_posts", "id", db.contentPosts.map((row) => row.id));
        await deleteMissing(client, "media_assets", "id", db.mediaAssets.map((row) => row.id));
        await deleteMissing(client, "event_public_profiles", "event_id", db.eventPublicProfiles.map((row) => row.eventId));
        await deleteMissing(client, "organization_documents", "id", db.organizationDocuments.map((row) => row.id));
        await deleteMissing(client, "file_cleanup_journal", "id", (db.fileCleanupJournal || []).map((row) => row.id));
        await deleteMissing(client, "certificate_import_errors", "id", db.certificateImportErrors.map((row) => row.id));
        await deleteMissing(client, "certificates", "id", db.certificates.map((row) => row.id));
        await deleteMissing(client, "certificate_import_batches", "id", db.certificateImportBatches.map((row) => row.id));
        await deleteMissing(client, "registration_submission_assets", "id", db.registrationSubmissionAssets.map((row) => row.id));
        await deleteMissing(client, "registration_upload_sessions", "id", db.registrationUploadSessions.map((row) => row.id));
        await deleteMissing(client, "registrations", "id", db.registrations.map((row) => row.id));
        await deleteMissing(client, "projects", "id", db.projects.map((row) => row.id));
        await deleteMissing(client, "organization_event_participations", "organization_id || ':' || event_id", db.organizationEventParticipations.map((row) => `${row.organizationId}:${row.eventId}`));
        await deleteMissing(client, "events", "id", db.events.map((row) => row.id));
        await deleteMissing(client, "memberships", "id", db.memberships.map((row) => row.id));
        await deleteMissing(client, "organizations", "id", db.organizations.map((row) => row.id));
        await deleteMissing(client, "audit_logs", "id", (db.auditLogs || []).map((row) => row.id));
        await deleteMissing(client, "users", "id", db.users.map((row) => row.id));

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        if (ownsClient) client.release();
      }
    },
    async close() {
      await pool.end();
    }
  };

  Object.defineProperty(store, "pool", {
    value: pool,
    enumerable: true,
    writable: false
  });

  return store;
}
