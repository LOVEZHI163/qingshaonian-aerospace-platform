import fs from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";

import { APPROVED_GROUP_NAMES, ensureDbShape, EVENT, PROJECTS, seedDb } from "./seed.js";
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
      for (const tableName of ["auth_rate_buckets", "password_reset_challenges", "file_cleanup_journal"]) {
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

export function createPostgresStore(pool) {
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
      if (count.rows[0].count === 0) await store.writeDb(structuredClone(seedDb));
    },
    async readDb() {
      const executor = activeContext()?.client || pool;
      const [events, projects, projectGroups, users, organizations, memberships, registrations, certificates, organizationDocuments, fileCleanupJournal] = await Promise.all([
        executor.query("SELECT * FROM events ORDER BY created_at, id"),
        executor.query("SELECT * FROM projects ORDER BY display_order, id"),
        executor.query("SELECT * FROM project_groups ORDER BY project_id, group_name"),
        executor.query("SELECT * FROM users ORDER BY created_at, id"),
        executor.query("SELECT * FROM organizations ORDER BY created_at, id"),
        executor.query("SELECT * FROM memberships ORDER BY created_at, id"),
        executor.query(`
          SELECT r.*, x.award_name, x.rank, x.score, x.recorded_at
          FROM registrations r
          LEFT JOIN results x ON x.registration_id = r.id
          ORDER BY r.created_at, r.id
        `),
        executor.query("SELECT * FROM certificates ORDER BY uploaded_at DESC, id"),
        executor.query("SELECT * FROM organization_documents ORDER BY uploaded_at DESC, id"),
        executor.query("SELECT * FROM file_cleanup_journal ORDER BY created_at, id")
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
        registrations: registrations.rows.map((row) => ({
          id: row.id,
          eventId: row.event_id,
          source: row.source,
          userId: row.user_id,
          organizationId: row.organization_id,
          organization: row.organization_name,
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
          userId: row.user_id,
          organizationId: row.organization_id,
          certificateNo: row.certificate_no,
          fileName: row.file_name,
          storedName: row.stored_name,
          filePath: row.file_path,
          awardName: row.award_name,
          rank: row.rank,
          score: row.score,
          status: row.status,
          uploadedAt: iso(row.uploaded_at),
          publishedAt: iso(row.published_at)
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
        fileCleanupJournal: fileCleanupJournal.rows.map((row) => ({ id: row.id, filePath: row.file_path, category: row.category, attempts: row.attempts, lastError: row.last_error, createdAt: iso(row.created_at), lastAttemptAt: iso(row.last_attempt_at) }))
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
              (id, event_id, name, type, category, enabled, instructor_required, display_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO UPDATE SET
               event_id = EXCLUDED.event_id,
               name = EXCLUDED.name,
               type = EXCLUDED.type,
               category = EXCLUDED.category,
               enabled = EXCLUDED.enabled,
               instructor_required = EXCLUDED.instructor_required,
               display_order = EXCLUDED.display_order`,
            [row.id, row.eventId, row.name, row.type, row.category, row.enabled, row.instructorRequired, row.displayOrder]
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
            `INSERT INTO users (id, name, phone, password, type, status, session_version, must_change_password, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET
               name = EXCLUDED.name,
               phone = EXCLUDED.phone,
               password = EXCLUDED.password,
               type = EXCLUDED.type,
               status = EXCLUDED.status,
               session_version = EXCLUDED.session_version,
               must_change_password = EXCLUDED.must_change_password,
               created_at = EXCLUDED.created_at`,
            [row.id, row.name, row.phone, row.password, row.type, row.status, row.sessionVersion, row.mustChangePassword, row.createdAt]
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

        for (const row of db.registrations) {
          await client.query(
            `INSERT INTO registrations
              (id, event_id, source, user_id, organization_id, organization_name, athlete, athlete_key,
               group_name, project_id, project_name, project_type, instructor, status, reject_reason, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
             ON CONFLICT (id) DO UPDATE SET
               event_id = EXCLUDED.event_id,
               source = EXCLUDED.source,
               user_id = EXCLUDED.user_id,
               organization_id = EXCLUDED.organization_id,
               organization_name = EXCLUDED.organization_name,
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
            [row.id, row.eventId || EVENT.id, row.source, row.userId || null, row.organizationId || null, row.organization || "", JSON.stringify(row.athlete || {}), row.athleteKey, row.group, row.projectId, row.projectName, row.projectType, row.instructor || "", row.status, row.rejectReason || "", row.createdAt, row.updatedAt]
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

        for (const row of db.certificates) {
          await client.query(
            `INSERT INTO certificates
              (id, registration_id, user_id, organization_id, certificate_no, file_name, stored_name, file_path,
               award_name, rank, score, status, uploaded_at, published_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (id) DO UPDATE SET
               registration_id = EXCLUDED.registration_id,
               user_id = EXCLUDED.user_id,
               organization_id = EXCLUDED.organization_id,
               certificate_no = EXCLUDED.certificate_no,
               file_name = EXCLUDED.file_name,
               stored_name = EXCLUDED.stored_name,
               file_path = EXCLUDED.file_path,
               award_name = EXCLUDED.award_name,
               rank = EXCLUDED.rank,
               score = EXCLUDED.score,
               status = EXCLUDED.status,
               uploaded_at = EXCLUDED.uploaded_at,
               published_at = EXCLUDED.published_at`,
            [row.id, row.registrationId, row.userId || null, row.organizationId || null, row.certificateNo, row.fileName, row.storedName, row.filePath, row.awardName || "", row.rank || "", row.score || "", row.status, row.uploadedAt, row.publishedAt || null]
          );
        }

        await deleteMissing(client, "organization_documents", "id", db.organizationDocuments.map((row) => row.id));
        await deleteMissing(client, "file_cleanup_journal", "id", (db.fileCleanupJournal || []).map((row) => row.id));
        await deleteMissing(client, "certificates", "id", db.certificates.map((row) => row.id));
        await deleteMissing(client, "registrations", "id", db.registrations.map((row) => row.id));
        await deleteMissing(client, "projects", "id", db.projects.map((row) => row.id));
        await deleteMissing(client, "memberships", "id", db.memberships.map((row) => row.id));
        await deleteMissing(client, "organizations", "id", db.organizations.map((row) => row.id));
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
