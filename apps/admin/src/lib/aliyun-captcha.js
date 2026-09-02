export const ALIYUN_CAPTCHA_SCRIPT = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

let loaderPromise = null;

export function loadAliyunCaptcha({ region, prefix }) {
  if (typeof window === "undefined") return Promise.reject(new Error("当前环境不支持人机验证"));
  window.AliyunCaptchaConfig = { region, prefix };
  if (typeof window.initAliyunCaptcha === "function") return Promise.resolve(window.initAliyunCaptcha);
  if (loaderPromise) return loaderPromise;

  loaderPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = ALIYUN_CAPTCHA_SCRIPT;
    script.async = true;
    script.dataset.aliyunCaptcha = "v3";
    script.addEventListener("load", () => {
      if (typeof window.initAliyunCaptcha === "function") resolve(window.initAliyunCaptcha);
      else reject(new Error("人机验证加载失败，请刷新后重试"));
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("人机验证加载失败，请检查网络后重试")), { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    loaderPromise = null;
    throw error;
  });
  return loaderPromise;
}

export function resetAliyunCaptchaLoaderForTests() {
  loaderPromise = null;
}
