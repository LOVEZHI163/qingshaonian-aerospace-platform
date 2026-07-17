import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import AdminShell from "../AdminShell.vue";

describe("AdminShell", () => {
  it("renders the complete admin navigation and emits its key", async () => {
    const wrapper = mount(AdminShell, { props: { active: "overview" } });

    for (const label of ["概览", "赛事管理", "赛项与组别", "组织用户", "报名管理", "证书管理", "普通用户管理"]) {
      expect(wrapper.text()).toContain(label);
    }
    await wrapper.get('[data-nav="events"]').trigger("click");
    expect(wrapper.emitted("navigate")[0]).toEqual(["events"]);
  });
});
