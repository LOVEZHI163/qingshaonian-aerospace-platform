<script setup>
import { getCurrentInstance, onBeforeUnmount, onMounted, ref } from "vue";

import { loadAliyunCaptcha } from "../lib/aliyun-captcha.js";

const props = defineProps({
  enabled: { type: Boolean, default: false },
  region: { type: String, default: "cn" },
  prefix: { type: String, default: "" },
  sceneId: { type: String, default: "" }
});

const uid = getCurrentInstance()?.uid ?? Math.random().toString(36).slice(2);
const elementId = `aliyun-captcha-${uid}`;
const buttonId = `aliyun-captcha-button-${uid}`;
const errorMessage = ref("");
let captchaInstance = null;
let readyPromise = null;
let pending = null;

function settle(kind, value) {
  if (!pending) return;
  const current = pending;
  pending = null;
  current[kind](value);
}

async function initialize() {
  if (!props.enabled) return;
  if (!props.sceneId || !props.prefix) throw new Error("人机验证暂不可用");
  const init = await loadAliyunCaptcha({ region: props.region, prefix: props.prefix });
  init({
    SceneId: props.sceneId,
    prefix: props.prefix,
    mode: "popup",
    element: `#${elementId}`,
    button: `#${buttonId}`,
    captchaVerifyCallback(captchaVerifyParam) {
      settle("resolve", captchaVerifyParam);
      return { captchaResult: true, bizResult: true };
    },
    onBizResultCallback() {},
    onError() {
      errorMessage.value = "人机验证失败，请重试";
      settle("reject", new Error(errorMessage.value));
    },
    onClose() {
      settle("reject", new Error("人机验证未完成"));
    },
    getInstance(instance) { captchaInstance = instance; }
  });
}

function execute() {
  errorMessage.value = "";
  if (!props.enabled) return Promise.resolve("");
  if (pending) return Promise.reject(new Error("人机验证正在进行中"));
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    Promise.resolve(readyPromise).then(() => {
      document.getElementById(buttonId)?.click();
    }).catch((error) => {
      errorMessage.value = error.message || "人机验证加载失败";
      settle("reject", error);
    });
  });
}

onMounted(() => {
  if (props.enabled) readyPromise = initialize();
});

onBeforeUnmount(() => {
  settle("reject", new Error("人机验证已取消"));
  try { captchaInstance?.destroy?.(); } catch {}
  captchaInstance = null;
});

defineExpose({ execute });
</script>

<template>
  <div class="aliyun-captcha-gate" aria-live="polite">
    <div :id="elementId"></div>
    <button :id="buttonId" type="button" tabindex="-1" aria-hidden="true"></button>
    <p v-if="errorMessage" class="auth-field-error" role="alert">{{ errorMessage }}</p>
  </div>
</template>
