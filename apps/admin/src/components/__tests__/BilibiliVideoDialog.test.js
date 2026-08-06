import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import BilibiliVideoDialog from "../BilibiliVideoDialog.vue";

describe("BilibiliVideoDialog", () => {
  it("associates the dialog instructions and displays the recognized BV id", async () => {
    const wrapper = mount(BilibiliVideoDialog, { props: { open: true } });

    const dialog = wrapper.get('[role="dialog"]');
    const descriptionId = dialog.attributes("aria-describedby");
    expect(descriptionId).toBe("bilibili-video-instructions");
    expect(wrapper.get(`#${descriptionId}`).text()).toBe(
      "填写B站完整视频链接或BV号和自定义标题，系统将生成封面与播放器。"
    );

    await wrapper.get('[data-field="bilibili-url"]').setValue("https://www.bilibili.com/video/BV1B7411m7LV");

    expect(wrapper.get('[data-bilibili-recognized]').text()).toBe("已识别：BV1B7411m7LV");
  });

  it("explains accepted input and previews a valid video", async () => {
    const wrapper = mount(BilibiliVideoDialog, { props: { open: true } });

    expect(wrapper.text()).toContain("暂不支持b23.tv短链接");
    await wrapper.get('[data-field="bilibili-url"]').setValue("https://www.bilibili.com/video/BV1B7411m7LV");
    await wrapper.get('[data-field="bilibili-title"]').setValue("比赛精彩回顾");

    expect(wrapper.get('iframe[title="B站视频预览：比赛精彩回顾"]').attributes("src")).toContain("bvid=BV1B7411m7LV");
    await wrapper.get('[data-action="confirm-bilibili-video"]').trigger("click");
    expect(wrapper.emitted("select").at(-1)[0]).toEqual({ bvid: "BV1B7411m7LV", title: "比赛精彩回顾" });
  });

  it("shows a short-link explanation and disables insertion", async () => {
    const wrapper = mount(BilibiliVideoDialog, { props: { open: true } });

    await wrapper.get('[data-field="bilibili-url"]').setValue("https://b23.tv/abcd");

    expect(wrapper.get('[role="alert"]').text()).toContain("暂不支持b23.tv短链接");
    expect(wrapper.get('[data-action="confirm-bilibili-video"]').attributes("disabled")).toBeDefined();
  });

  it("requires a title and restores initial values when editing", async () => {
    const wrapper = mount(BilibiliVideoDialog, {
      props: { open: true, initial: { bvid: "BV1B7411m7LV", title: "原标题" } }
    });

    expect(wrapper.get('[data-field="bilibili-title"]').element.value).toBe("原标题");
    await wrapper.get('[data-field="bilibili-title"]').setValue("");

    expect(wrapper.text()).toContain("请填写视频标题");
    expect(wrapper.get('[data-action="confirm-bilibili-video"]').attributes("disabled")).toBeDefined();
  });
});
