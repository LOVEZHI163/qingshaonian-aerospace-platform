import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import AdminShell from "../AdminShell.vue";

describe("AdminShell", () => {
  it("renders one event settings navigation entry and emits events", async () => {
    const wrapper = mount(AdminShell, { props: { active: "overview" } });

    expect(wrapper.findAll("[data-nav]").map((item) => item.text())).toEqual([
      "概览", "赛事设置", "报名管理", "证书管理", "官网内容", "组织用户", "普通用户管理"
    ]);
    expect(wrapper.find('[data-nav="projects"]').exists()).toBe(false);

    await wrapper.get('[data-nav="events"]').trigger("click");
    expect(wrapper.emitted("navigate")[0]).toEqual(["events"]);
  });

  it("groups navigation, uses the official logo and expands the rail on hover", () => {
    const wrapper = mount(AdminShell, { props: { active: "overview" } });

    expect(wrapper.findAll(".admin-nav-group-label").map((item) => item.text()))
      .toEqual(["工作台", "赛事运营", "内容与用户"]);
    expect(wrapper.get(".admin-brand-mark img").attributes("src")).toBe("/brand/mark.svg");
    expect(wrapper.find(".sidebar-collapse-toggle").exists()).toBe(false);
  });

  it("opens the mobile drawer and closes it after navigation", async () => {
    const wrapper = mount(AdminShell, { props: { active: "overview" } });

    await wrapper.get(".sidebar-mobile-trigger").trigger("click");
    expect(wrapper.get('[data-testid="admin-shell"]').classes()).toContain("sidebar-mobile-open");
    expect(wrapper.get(".sidebar-mobile-trigger").attributes("aria-expanded")).toBe("true");

    await wrapper.get('[data-nav="certificates"]').trigger("click");
    expect(wrapper.get('[data-testid="admin-shell"]').classes()).not.toContain("sidebar-mobile-open");
    expect(wrapper.emitted("navigate")[0]).toEqual(["certificates"]);
  });

  it("renders account actions in the sidebar footer instead of the header", () => {
    const wrapper = mount(AdminShell, {
      props: { active: "overview" },
      slots: {
        "sidebar-footer": '<button data-action="logout">退出登录</button>'
      }
    });

    expect(wrapper.get('.admin-sidebar-footer [data-action="logout"]').text()).toBe("退出登录");
    expect(wrapper.find('.admin-header [data-action="logout"]').exists()).toBe(false);
  });
});
