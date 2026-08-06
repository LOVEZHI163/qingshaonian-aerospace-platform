import { flushPromises, mount as vueMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, loadAdminRegistrationsMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  loadAdminRegistrationsMock: vi.fn()
}));

vi.mock("../../lib/api.js", () => ({ api: apiMock }));
vi.mock("../../lib/admin-registrations.js", () => ({
  loadAdminRegistrations: loadAdminRegistrationsMock
}));

import CertificateSlotEditor from "../CertificateSlotEditor.vue";
import ManualCertificateEntryPanel from "../ManualCertificateEntryPanel.vue";
const mount = (component, options = {}) => vueMount(component, {
  ...options,
  props: { ...options.props, eventId: options.props?.eventId ?? options.props?.initialEventId ?? "" }
});

const events = [
  { id: "E1", name: "2026 青少年航空赛" },
  { id: "E2", name: "2027 青少年航空赛" }
];

const sameNameProjectOne = {
  id: "R1",
  eventId: "E1",
  group: "小学低段",
  projectId: "P1",
  projectName: "纸飞机",
  status: "approved",
  awardName: "二等奖",
  rank: "2",
  score: "96",
  athlete: { name: "张三", school: "实验小学", grade: "三年级" }
};

const sameNameProjectTwo = {
  ...sameNameProjectOne,
  id: "R2",
  projectId: "P2",
  projectName: "橡筋飞机",
  group: "小学高段"
};

const certificateOne = {
  id: "C1",
  registrationId: "R1",
  slot: 1,
  title: "一等奖证书",
  status: "draft",
  fileName: "one.pdf",
  previewUrl: "/api/certificates/C1/file",
  downloadUrl: "/api/certificates/C1/file?download=1"
};

const certificateTwo = {
  id: "C2",
  registrationId: "R1",
  slot: 2,
  title: "优秀选手证书",
  status: "draft",
  fileName: "two.pdf"
};

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

describe("ManualCertificateEntryPanel", () => {
  beforeEach(() => {
    apiMock.mockReset();
    loadAdminRegistrationsMock.mockReset();
    apiMock.mockResolvedValue({ rows: [] });
    loadAdminRegistrationsMock.mockResolvedValue([]);
  });

  it("does not search an empty name and only requests approved athlete-name matches", async () => {
    const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
    await wrapper.get('[data-action="search-student"]').trigger("click");
    expect(loadAdminRegistrationsMock).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain("请输入学生姓名");

    await wrapper.get("[data-manual-name]").setValue("张三");
    await wrapper.get('[data-action="search-student"]').trigger("click");
    await flushPromises();
    expect(loadAdminRegistrationsMock).toHaveBeenCalledWith({
      eventId: "E1",
      status: "approved",
      athleteName: "张三"
    });
  });

  it("does not search across events when no event is selected", async () => {
    const wrapper = mount(ManualCertificateEntryPanel, { props: { events: [] } });
    await wrapper.get("[data-manual-name]").setValue("张三");
    expect(wrapper.get('[data-action="search-student"]').attributes()).toHaveProperty("disabled");

    await wrapper.get("form").trigger("submit");
    expect(loadAdminRegistrationsMock).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain("请先选择赛事");
  });

  it("shows same-name project rows and loads the selected registration certificates", async () => {
    loadAdminRegistrationsMock.mockResolvedValue([sameNameProjectOne, sameNameProjectTwo]);
    const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
    await wrapper.get("[data-manual-name]").setValue("张三");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    const rows = wrapper.findAll("[data-manual-result]");
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("实验小学");
    expect(rows[0].text()).toContain("小学低段");
    expect(rows[0].text()).toContain("纸飞机");
    expect(rows[0].text()).toContain("R1");
    expect(rows[0].text()).toContain("2026 青少年航空赛");
    expect(rows[1].text()).toContain("2026 青少年航空赛");

    await rows[1].trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("registrationId=R2"));
  });

  it("does not render an independent event selector", async () => {
    loadAdminRegistrationsMock.mockResolvedValue([sameNameProjectOne]);
    const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
    await wrapper.get("[data-manual-name]").setValue("张三");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.findAll("[data-manual-result]")).toHaveLength(1);

    expect(wrapper.find("[data-manual-event]").exists()).toBe(false);
    expect(wrapper.findAll("[data-manual-result]")).toHaveLength(1);
  });

  it("ignores an older search response", async () => {
    const older = deferred();
    loadAdminRegistrationsMock.mockReturnValueOnce(older.promise).mockResolvedValueOnce([sameNameProjectTwo]);
    const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
    await wrapper.get("[data-manual-name]").setValue("张");
    await wrapper.get("form").trigger("submit");
    await wrapper.get("[data-manual-name]").setValue("张三");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    older.resolve([sameNameProjectOne]);
    await flushPromises();
    expect(wrapper.findAll("[data-manual-result]")).toHaveLength(1);
    expect(wrapper.get("[data-manual-result]").text()).toContain("R2");
  });

  it("clears the previous registration and certificate editor as soon as a new search starts", async () => {
    const nextSearch = deferred();
    loadAdminRegistrationsMock
      .mockResolvedValueOnce([sameNameProjectOne])
      .mockReturnValueOnce(nextSearch.promise);
    apiMock.mockResolvedValueOnce({ rows: [certificateOne] });
    const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
    await wrapper.get("[data-manual-name]").setValue("张三");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    await wrapper.get("[data-manual-result]").trigger("click");
    await flushPromises();
    expect(wrapper.findComponent(CertificateSlotEditor).exists()).toBe(true);

    await wrapper.get("[data-manual-name]").setValue("李四");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.findAll("[data-manual-result]")).toHaveLength(0);
    expect(wrapper.find("[data-manual-selected]").exists()).toBe(false);
    expect(wrapper.findComponent(CertificateSlotEditor).exists()).toBe(false);

    nextSearch.resolve([sameNameProjectTwo]);
    await flushPromises();
  });

  it("invalidates a pending search before rejecting an empty-name submission", async () => {
    const pendingSearch = deferred();
    loadAdminRegistrationsMock.mockReturnValueOnce(pendingSearch.promise);
    const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
    await wrapper.get("[data-manual-name]").setValue("张三");
    await wrapper.get("form").trigger("submit");

    await wrapper.get("[data-manual-name]").setValue("");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.get('[role="alert"]').text()).toContain("请输入学生姓名");

    pendingSearch.resolve([sameNameProjectOne]);
    await flushPromises();
    expect(wrapper.findAll("[data-manual-result]")).toHaveLength(0);
    expect(wrapper.find("[data-manual-selected]").exists()).toBe(false);
  });

  it("shows the approved-registration empty state", async () => {
    loadAdminRegistrationsMock.mockResolvedValue([]);
    const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
    await wrapper.get("[data-manual-name]").setValue("不存在的学生");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("未找到已通过的报名记录");
  });

  it("saves three independent result fields and passes both certificate slots to the editor", async () => {
    loadAdminRegistrationsMock.mockResolvedValue([sameNameProjectOne]);
    apiMock.mockResolvedValueOnce({ rows: [certificateOne, certificateTwo] }).mockResolvedValueOnce({ row: sameNameProjectOne });
    const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
    await wrapper.get("[data-manual-name]").setValue("张三");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    await wrapper.get("[data-manual-result]").trigger("click");
    await flushPromises();

    expect(wrapper.getComponent(CertificateSlotEditor).props("certificates")).toEqual([certificateOne, certificateTwo]);
    await wrapper.get('[data-result="awardName"]').setValue("一等奖");
    await wrapper.get('[data-result="rank"]').setValue("1");
    await wrapper.get('[data-result="score"]').setValue("99");
    await wrapper.get('[data-action="save-result"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/events/E1/registrations/R1/result", {
      method: "POST",
      body: JSON.stringify({ awardName: "一等奖", rank: "1", score: "99" })
    });
  });

  it("does not expose direct publish or withdraw while preserving manual certificate operations", async () => {
    loadAdminRegistrationsMock.mockResolvedValue([sameNameProjectOne]);
    apiMock.mockResolvedValueOnce({ rows: [certificateOne] });
    const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
    await wrapper.get("[data-manual-name]").setValue("张三");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    await wrapper.get("[data-manual-result]").trigger("click");
    await flushPromises();

    const editor = wrapper.getComponent(CertificateSlotEditor);
    const buttonTexts = editor.findAll("button").map((button) => button.text());
    expect(editor.props("allowStatusChange")).toBe(false);
    expect(buttonTexts).not.toContain("发布");
    expect(buttonTexts).not.toContain("撤回");
    expect(editor.get('[data-action="save-slot-1"]').text()).toContain("保存标题");
    expect(editor.get('[data-action="save-slot-2"]').text()).toContain("上传文件");
    expect(editor.get('[data-action="preview-C1"]').text()).toBe("预览");
    expect(editor.get('[data-action="download-C1"]').text()).toBe("下载");
    expect(editor.get('[data-action="request-delete-C1"]').text()).toBe("删除");
    expect(editor.findAll("[data-slot-file]")).toHaveLength(2);

    const replacement = editor.get('[data-slot-file="1"]');
    Object.defineProperty(replacement.element, "files", {
      configurable: true,
      value: [new File(["pdf"], "replacement.pdf", { type: "application/pdf" })]
    });
    await replacement.trigger("change");
    expect(editor.get('[data-action="save-slot-1"]').text()).toContain("替换文件");
  });

  it("keeps certificate editing hidden while the certificate request is pending", async () => {
    const certificateRequest = deferred();
    loadAdminRegistrationsMock.mockResolvedValue([sameNameProjectOne]);
    apiMock.mockReturnValueOnce(certificateRequest.promise);
    const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
    await wrapper.get("[data-manual-name]").setValue("张三");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    await wrapper.get("[data-manual-result]").trigger("click");

    expect(wrapper.text()).toContain("正在加载证书");
    expect(wrapper.findComponent(CertificateSlotEditor).exists()).toBe(false);
    expect(wrapper.find("[data-slot-file]").exists()).toBe(false);
    expect(wrapper.find('[data-action^="save-slot-"]').exists()).toBe(false);
    expect(wrapper.find('[data-action^="request-delete-"]').exists()).toBe(false);

    certificateRequest.resolve({ rows: [] });
    await flushPromises();
  });

  it("keeps certificate editing hidden after a load failure and exposes it only after retry succeeds", async () => {
    loadAdminRegistrationsMock.mockResolvedValue([sameNameProjectOne]);
    apiMock
      .mockRejectedValueOnce(new Error("证书服务暂不可用"))
      .mockResolvedValueOnce({ rows: [] });
    const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
    await wrapper.get("[data-manual-name]").setValue("张三");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    await wrapper.get("[data-manual-result]").trigger("click");
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain("证书服务暂不可用");
    expect(wrapper.findComponent(CertificateSlotEditor).exists()).toBe(false);
    expect(wrapper.find("[data-slot-file]").exists()).toBe(false);
    expect(wrapper.find('[data-action^="save-slot-"]').exists()).toBe(false);
    expect(wrapper.find('[data-action^="request-delete-"]').exists()).toBe(false);

    await wrapper.get('[data-action="retry-certificates"]').trigger("click");
    await flushPromises();
    expect(wrapper.findComponent(CertificateSlotEditor).exists()).toBe(true);
    expect(wrapper.findAll("[data-slot-file]")).toHaveLength(2);
  });

  it("preserves explicitly cleared result fields after saving", async () => {
    const cleared = { ...sameNameProjectOne, awardName: "", rank: "", score: "" };
    loadAdminRegistrationsMock.mockResolvedValue([sameNameProjectOne]);
    apiMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ row: cleared });
    const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
    await wrapper.get("[data-manual-name]").setValue("张三");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    await wrapper.get("[data-manual-result]").trigger("click");
    await flushPromises();

    await wrapper.get('[data-result="awardName"]').setValue("");
    await wrapper.get('[data-result="rank"]').setValue("");
    await wrapper.get('[data-result="score"]').setValue("");
    await wrapper.get('[data-action="save-result"]').trigger("click");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/events/E1/registrations/R1/result", {
      method: "POST",
      body: JSON.stringify({ awardName: "", rank: "", score: "" })
    });
    expect(wrapper.get('[data-result="awardName"]').element.value).toBe("");
    expect(wrapper.get('[data-result="rank"]').element.value).toBe("");
    expect(wrapper.get('[data-result="score"]').element.value).toBe("");
  });

  it("reloads the selected certificates before forwarding an editor change", async () => {
    loadAdminRegistrationsMock.mockResolvedValue([sameNameProjectOne]);
    apiMock
      .mockResolvedValueOnce({ rows: [certificateOne] })
      .mockResolvedValueOnce({ rows: [certificateOne, certificateTwo] });
    const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
    await wrapper.get("[data-manual-name]").setValue("张三");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    await wrapper.get("[data-manual-result]").trigger("click");
    await flushPromises();

    wrapper.getComponent(CertificateSlotEditor).vm.$emit("changed", { message: "证书位置 2 已保存。" });
    await flushPromises();
    expect(wrapper.getComponent(CertificateSlotEditor).props("certificates")).toEqual([certificateOne, certificateTwo]);
    expect(wrapper.emitted("changed")).toEqual([[{ message: "证书位置 2 已保存。" }]]);
  });

  it("does not expose an independent event selector during a result save", async () => {
    const olderSave = deferred();
    loadAdminRegistrationsMock.mockResolvedValue([sameNameProjectOne]);
    apiMock.mockImplementation((path, options = {}) => {
      if (path === "/api/admin/events/E1/registrations/R1/result" && options.method === "POST") return olderSave.promise;
      return Promise.resolve({ rows: [] });
    });
    const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
    await wrapper.get("[data-manual-name]").setValue("张三");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    await wrapper.get("[data-manual-result]").trigger("click");
    await flushPromises();

    await wrapper.get('[data-result="awardName"]').setValue("一等奖");
    await wrapper.get('[data-action="save-result"]').trigger("click");
    expect(wrapper.find("[data-manual-event]").exists()).toBe(false);

    olderSave.resolve({ row: { ...sameNameProjectOne, awardName: "一等奖" } });
    await flushPromises();
    expect(wrapper.text()).toContain("成绩已保存");
  });

  it("opens an approved direct registration by exact id", async () => {
    loadAdminRegistrationsMock.mockResolvedValue([sameNameProjectOne]);
    const wrapper = mount(ManualCertificateEntryPanel, {
      props: { events, initialEventId: "E1", initialRegistrationId: "R1" }
    });
    await flushPromises();
    expect(loadAdminRegistrationsMock).toHaveBeenCalledWith({ eventId: "E1", q: "R1" });
    expect(wrapper.get("[data-manual-selected]").text()).toContain("R1");
  });

  it("blocks a direct registration that is not approved", async () => {
    loadAdminRegistrationsMock.mockResolvedValue([{ ...sameNameProjectOne, status: "pending" }]);
    const wrapper = mount(ManualCertificateEntryPanel, {
      props: { events, initialEventId: "E1", initialRegistrationId: "R1" }
    });
    await flushPromises();
    expect(wrapper.text()).toContain("报名审核通过后才能录入证书");
    expect(wrapper.findComponent(CertificateSlotEditor).exists()).toBe(false);
  });
});
