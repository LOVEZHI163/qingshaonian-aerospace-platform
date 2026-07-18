import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import AdminShell from "../AdminShell.vue";

describe("AdminShell", () => {
  it("renders one event settings navigation entry and emits events", async () => {
    const wrapper = mount(AdminShell, { props: { active: "overview" } });

    expect(wrapper.findAll("[data-nav]").map((item) => item.text())).toEqual([
      "概览", "赛事设置", "组织用户", "报名管理", "证书管理", "普通用户管理"
    ]);
    expect(wrapper.find('[data-nav="projects"]').exists()).toBe(false);

    await wrapper.get('[data-nav="events"]').trigger("click");
    expect(wrapper.emitted("navigate")[0]).toEqual(["events"]);
  });
});
