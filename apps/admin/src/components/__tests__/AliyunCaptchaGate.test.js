import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

const captchaModule = await import("../../lib/aliyun-captcha.js").catch(() => ({}));
const componentModule = await import("../AliyunCaptchaGate.vue").catch(() => ({}));

describe("AliyunCaptchaGate", () => {
  afterEach(() => {
    document.querySelectorAll('script[data-aliyun-captcha="v3"]').forEach((node) => node.remove());
    delete window.initAliyunCaptcha;
    delete window.AliyunCaptchaConfig;
    captchaModule.resetAliyunCaptchaLoaderForTests?.();
  });

  it("does not load the remote SDK when disabled", async () => {
    expect(componentModule.default).toBeTruthy();
    const wrapper = mount(componentModule.default, { props: { enabled: false, sceneId: "scene" } });
    await expect(wrapper.vm.execute()).resolves.toBe("");
    expect(document.querySelector('script[data-aliyun-captcha="v3"]')).toBeNull();
  });

  it("loads the SDK only once after setting its public configuration", async () => {
    expect(typeof captchaModule.loadAliyunCaptcha).toBe("function");
    const first = captchaModule.loadAliyunCaptcha({ region: "cn", prefix: "prefix-1" });
    const second = captchaModule.loadAliyunCaptcha({ region: "cn", prefix: "prefix-1" });
    const scripts = document.querySelectorAll('script[data-aliyun-captcha="v3"]');
    expect(scripts).toHaveLength(1);
    expect(window.AliyunCaptchaConfig).toEqual({ region: "cn", prefix: "prefix-1" });
    window.initAliyunCaptcha = vi.fn();
    scripts[0].dispatchEvent(new Event("load"));
    await expect(first).resolves.toBe(window.initAliyunCaptcha);
    await expect(second).resolves.toBe(window.initAliyunCaptcha);
  });

  it("initializes popup mode and returns the original signed parameter", async () => {
    let options;
    const destroy = vi.fn();
    window.initAliyunCaptcha = vi.fn((input) => {
      options = input;
      input.getInstance?.({ destroy });
    });
    const wrapper = mount(componentModule.default, {
      attachTo: document.body,
      props: { enabled: true, region: "cn", prefix: "prefix-1", sceneId: "scene-1" }
    });
    await flushPromises();
    expect(options.mode).toBe("popup");
    expect(options.SceneId).toBe("scene-1");
    expect(options.element).toMatch(/^#/);
    expect(options.button).toMatch(/^#/);

    const pending = wrapper.vm.execute();
    const result = options.captchaVerifyCallback("signed-param");
    expect(result).toEqual({ captchaResult: true, bizResult: true });
    await expect(pending).resolves.toBe("signed-param");
    wrapper.unmount();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
