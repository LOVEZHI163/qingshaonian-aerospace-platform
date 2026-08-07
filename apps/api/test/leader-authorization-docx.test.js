import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import { buildLeaderAuthorizationDocx } from "../src/exports/leader-authorization-docx.js";

test("leader authorization DOCX is a generic organization template with the supplied leader details", async () => {
  const buffer = await buildLeaderAuthorizationDocx({
    organizationName: "温州市实验小学",
    leaderName: "张老师",
    leaderPhone: "13800000000",
    eventName: "不应写入模板的赛事名称"
  });

  assert.equal(buffer.subarray(0, 2).toString(), "PK");
  const archive = await JSZip.loadAsync(buffer);
  const documentXml = await archive.file("word/document.xml").async("string");
  assert.match(documentXml, /温州市实验小学/);
  assert.match(documentXml, /张老师/);
  assert.match(documentXml, /13800000000/);
  assert.match(documentXml, /学校\/机构授权该负责人作为本组织赛事领队/);
  assert.match(documentXml, /报名联络、资料核对与赛事沟通/);
  assert.match(documentXml, /签章/);
  assert.match(documentXml, /日期/);
  assert.doesNotMatch(documentXml, /不应写入模板的赛事名称/);
});
