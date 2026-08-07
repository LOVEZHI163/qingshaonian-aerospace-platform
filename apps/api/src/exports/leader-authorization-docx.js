import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun
} from "docx";

function text(value, fallback) {
  return String(value ?? "").trim() || fallback;
}

export async function buildLeaderAuthorizationDocx({ organizationName, leaderName, leaderPhone } = {}) {
  const organization = text(organizationName, "________________（学校/机构名称）");
  const name = text(leaderName, "________________");
  const phone = text(leaderPhone, "________________");
  const bodyStyle = { font: "Microsoft YaHei", size: 24 };
  const document = new Document({
    sections: [{
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          heading: HeadingLevel.TITLE,
          children: [new TextRun({ text: "组织领队授权书", bold: true, font: "Microsoft YaHei", size: 36 })]
        }),
        new Paragraph({ children: [new TextRun({ text: `组织名称：${organization}`, ...bodyStyle })] }),
        new Paragraph({ children: [new TextRun({ text: `领队姓名：${name}`, ...bodyStyle })] }),
        new Paragraph({ children: [new TextRun({ text: `手机号码：${phone}`, ...bodyStyle })] }),
        new Paragraph({
          spacing: { before: 360, line: 420 },
          children: [new TextRun({
            text: "学校/机构授权该负责人作为本组织赛事领队，负责报名联络、资料核对与赛事沟通。该授权为通用组织授权，不绑定任何具体赛事。",
            ...bodyStyle
          })]
        }),
        new Paragraph({ spacing: { before: 720 }, children: [new TextRun({ text: "学校/机构签章：________________", ...bodyStyle })] }),
        new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "日期：______年____月____日", ...bodyStyle })] })
      ]
    }]
  });
  return Packer.toBuffer(document);
}
