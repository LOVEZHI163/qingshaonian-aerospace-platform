import fs from "node:fs/promises";

import { APPROVED_GROUP_NAMES, ensureDbShape, EVENT, PROJECTS, seedDb } from "./seed.js";

const schemaUrl = new URL("./schema.sql", import.meta.url);
const migrationsUrl = new URL("./migrations/", import.meta.url);

function iso(value) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function deleteMissing(client, table, key, ids) {
  const keep = new Set(ids);
  const existing = await client.query(`SELECT ${key} AS id FROM ${table}`);
  for (const row of existing.rows) {
    if (!keep.has(row.id)) await client.query(`DELETE FROM ${table} WHERE ${key} = $1`, [row.id]);
  }
}

async function runMigrations(pool) {
  const names = (await fs.readdir(migrationsUrl))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  let supportsPlpgsql = true;
  try {
    await pool.query("DO $$ BEGIN END $$;");
  } catch {
    supportsPlpgsql = false;
  }
  for (const name of names) {
    let migration = await fs.readFile(new URL(name, migrationsUrl), "utf8");
    const projectGroups = await pool.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'project_groups'
    `);
    if (projectGroups.rowCount > 0) {
      migration = migration.replace(/CREATE TABLE IF NOT EXISTS project_groups \([\s\S]*?\);\s*/, "");
    }
    if (!supportsPlpgsql) {
      migration = migration.replace(/DO \$\$[\s\S]*?END \$\$;/g, "");
    }
    await pool.query(migration);
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
  const projects = await pool.query("SELECT id FROM projects");
  for (const project of projects.rows) {
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

export function createPostgresStore(pool) {
  const store = {
    kind: "postgres",
    async initialize() {
      await runSchema(pool);
      await runMigrations(pool);
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
        for (const project of PROJECTS) {
          await client.query(
            `INSERT INTO projects
              (id, event_id, name, type, category, enabled, instructor_required, display_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO NOTHING`,
            [project.id, project.eventId || EVENT.id, project.name, project.type, project.category, project.enabled, project.instructorRequired, project.displayOrder]
          );
        }
        for (const project of PROJECTS) {
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
      const [events, projects, projectGroups, users, organizations, memberships, registrations, certificates] = await Promise.all([
        pool.query("SELECT * FROM events ORDER BY created_at, id"),
        pool.query("SELECT * FROM projects ORDER BY display_order, id"),
        pool.query("SELECT * FROM project_groups ORDER BY project_id, group_name"),
        pool.query("SELECT * FROM users ORDER BY created_at, id"),
        pool.query("SELECT * FROM organizations ORDER BY created_at, id"),
        pool.query("SELECT * FROM memberships ORDER BY created_at, id"),
        pool.query(`
          SELECT r.*, x.award_name, x.rank, x.score, x.recorded_at
          FROM registrations r
          LEFT JOIN results x ON x.registration_id = r.id
          ORDER BY r.created_at, r.id
        `),
        pool.query("SELECT * FROM certificates ORDER BY uploaded_at DESC, id")
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
          date: row.date_label,
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
          createdAt: iso(row.created_at)
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
        }))
      });
    },
    async writeDb(input) {
      const db = ensureDbShape(structuredClone(input));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

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
              row.id, row.name, row.theme, row.date, row.venue, row.registrationDeadline, row.contact,
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
            `INSERT INTO users (id, name, phone, password, type, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET
               name = EXCLUDED.name,
               phone = EXCLUDED.phone,
               password = EXCLUDED.password,
               type = EXCLUDED.type,
               status = EXCLUDED.status,
               created_at = EXCLUDED.created_at`,
            [row.id, row.name, row.phone, row.password, row.type, row.status, row.createdAt]
          );
        }

        for (const row of db.organizations) {
          await client.query(
            `INSERT INTO organizations
              (id, name, code, owner_user_id, contact_name, contact_phone, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO UPDATE SET
               name = EXCLUDED.name,
               code = EXCLUDED.code,
               owner_user_id = EXCLUDED.owner_user_id,
               contact_name = EXCLUDED.contact_name,
               contact_phone = EXCLUDED.contact_phone,
               status = EXCLUDED.status,
               created_at = EXCLUDED.created_at`,
            [row.id, row.name, row.code, row.ownerUserId, row.contactName || "", row.contactPhone || "", row.status, row.createdAt]
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

        await deleteMissing(client, "certificates", "id", db.certificates.map((row) => row.id));
        await deleteMissing(client, "registrations", "id", db.registrations.map((row) => row.id));
        await deleteMissing(client, "memberships", "id", db.memberships.map((row) => row.id));
        await deleteMissing(client, "organizations", "id", db.organizations.map((row) => row.id));
        await deleteMissing(client, "users", "id", db.users.map((row) => row.id));

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    }
  };

  return store;
}
