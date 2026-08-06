import assert from "node:assert/strict";
import test from "node:test";

import { groupForGrade } from "../src/domain/grades.js";
import { isRegistrationOpen } from "../src/domain/registration-window.js";

test("maps school grades into the four approved groups", () => {
  assert.equal(groupForGrade("一年级"), "小学低段");
  assert.equal(groupForGrade("六年级"), "小学高段");
  assert.equal(groupForGrade("初三"), "中学组");
  assert.equal(groupForGrade("高二"), "职高/高中组");
  assert.equal(groupForGrade("职高一年级"), "职高/高中组");
  assert.equal(groupForGrade("大学一年级"), null);
});

test("registration override wins over scheduled dates", () => {
  const event = {
    registrationStartAt: "2026-10-01T00:00:00.000Z",
    registrationEndAt: "2026-10-31T15:59:59.000Z",
    registrationMode: "automatic"
  };
  assert.equal(isRegistrationOpen(event, new Date("2026-10-15T00:00:00.000Z")).open, true);
  assert.equal(isRegistrationOpen({ ...event, registrationMode: "force_closed" }, new Date("2026-10-15T00:00:00.000Z")).open, false);
  assert.equal(isRegistrationOpen({ ...event, registrationMode: "force_open" }, new Date("2027-01-01T00:00:00.000Z")).open, true);
});

test("registration window includes both configured boundaries", () => {
  const event = {
    registrationStartAt: "2026-10-01T00:00:00.000Z",
    registrationEndAt: "2026-10-31T15:59:59.000Z",
    registrationMode: "automatic"
  };

  assert.deepEqual(isRegistrationOpen(event, new Date(event.registrationStartAt)), { open: true, reason: "报名进行中" });
  assert.deepEqual(isRegistrationOpen(event, new Date(event.registrationEndAt)), { open: true, reason: "报名进行中" });
  assert.deepEqual(isRegistrationOpen(event, new Date("2026-09-30T23:59:59.999Z")), { open: false, reason: "报名尚未开始" });
  assert.deepEqual(isRegistrationOpen(event, new Date("2026-10-31T16:00:00.000Z")), { open: false, reason: "报名已截止" });
});

test("registration closes when its configured window is invalid", () => {
  const valid = {
    registrationStartAt: "2026-10-01T00:00:00.000Z",
    registrationEndAt: "2026-10-31T15:59:59.000Z",
    registrationMode: "automatic"
  };

  for (const event of [
    { ...valid, registrationStartAt: "" },
    { ...valid, registrationEndAt: "not-a-date" },
    { ...valid, registrationStartAt: "2026-11-01T00:00:00.000Z", registrationEndAt: "2026-10-01T00:00:00.000Z" }
  ]) {
    assert.deepEqual(isRegistrationOpen(event, new Date("2026-10-15T00:00:00.000Z")), { open: false, reason: "报名配置错误" });
  }
});
