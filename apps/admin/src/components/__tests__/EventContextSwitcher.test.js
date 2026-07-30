import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import EventContextSwitcher from "../EventContextSwitcher.vue";

const events = [
  { event: { id: "E1", name: "春季赛" } },
  { event: { id: "E2", name: "历史赛", archivedAt: "2025-12-31" } }
];

describe("EventContextSwitcher", () => {
  it("shows active events and emits a selected event id", async () => {
    const wrapper = mount(EventContextSwitcher, { props: { events, modelValue: "E1" } });

    expect(wrapper.get("[data-event-switcher]").element.value).toBe("E1");
    expect(wrapper.findAll("option").map((option) => option.text())).toEqual(["请选择赛事", "春季赛"]);

    await wrapper.get("[data-event-switcher]").setValue("E1");
    expect(wrapper.emitted("update:modelValue")[0]).toEqual(["E1"]);
  });

  it("can include archived events without coupling to an account type", () => {
    const wrapper = mount(EventContextSwitcher, { props: { events, includeArchived: true } });

    expect(wrapper.findAll("option").map((option) => option.text())).toEqual(["请选择赛事", "春季赛", "历史赛"]);
  });
});
