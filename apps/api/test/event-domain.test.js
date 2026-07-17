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
