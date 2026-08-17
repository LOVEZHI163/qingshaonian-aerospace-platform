import nodemailer from "nodemailer";

const REQUIRED = [
  "DIRECTMAIL_SMTP_HOST",
  "DIRECTMAIL_SMTP_PORT",
  "DIRECTMAIL_SMTP_USER",
  "DIRECTMAIL_SMTP_PASSWORD",
  "DIRECTMAIL_FROM"
];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function deliveryError() {
  const error = new Error("邮件暂时无法发送，请稍后重试");
  error.code = "EMAIL_DELIVERY_FAILED";
  return error;
}

function messageBody({ heading, intro, url, action, expiresMinutes }) {
  const safeUrl = escapeHtml(url);
  return `<!doctype html><html lang="zh-CN"><body style="font-family:Arial,'Microsoft YaHei',sans-serif;color:#10213d;line-height:1.7">
    <h2>${escapeHtml(heading)}</h2>
    <p>${escapeHtml(intro)}</p>
    <p><a href="${safeUrl}" style="display:inline-block;padding:10px 18px;background:#1769e0;color:#fff;text-decoration:none;border-radius:6px">${escapeHtml(action)}</a></p>
    <p>链接将在 ${escapeHtml(expiresMinutes)} 分钟后失效，且只能使用一次。</p>
    <p>如果按钮无法打开，请复制以下地址到浏览器：<br><span>${safeUrl}</span></p>
    <p>如果不是您本人操作，请忽略此邮件。</p>
  </body></html>`;
}

export function createEmailProvider(env = process.env, { transportFactory = nodemailer.createTransport } = {}) {
  if (REQUIRED.some((key) => !String(env[key] || "").trim())) return null;
  const port = Number(env.DIRECTMAIL_SMTP_PORT);
  const transport = transportFactory({
    host: env.DIRECTMAIL_SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: env.DIRECTMAIL_SMTP_USER, pass: env.DIRECTMAIL_SMTP_PASSWORD }
  });

  async function send(message) {
    try {
      await transport.sendMail({ from: env.DIRECTMAIL_FROM, ...message });
    } catch {
      throw deliveryError();
    }
  }

  return {
    sendVerification({ to, verifyUrl, expiresMinutes }) {
      return send({
        to,
        subject: "请验证您的账户邮箱",
        html: messageBody({ heading: "验证账户邮箱", intro: "请点击下面的按钮完成邮箱验证。", url: verifyUrl, action: "验证邮箱", expiresMinutes })
      });
    },
    sendPasswordReset({ to, resetUrl, expiresMinutes }) {
      return send({
        to,
        subject: "重置您的账户密码",
        html: messageBody({ heading: "重置账户密码", intro: "我们收到了您的密码重置申请。", url: resetUrl, action: "重置密码", expiresMinutes })
      });
    },
    sendSecurityNotice({ to, kind }) {
      const changed = kind === "password_changed";
      return send({
        to,
        subject: changed ? "您的账户密码已修改" : "您的账户安全信息已更新",
        html: `<p>${changed ? "您的账户密码刚刚完成修改。" : "您的账户安全信息刚刚完成更新。"}</p><p>如果不是您本人操作，请立即联系赛事平台管理员。</p>`
      });
    }
  };
}
