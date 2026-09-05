import { onBeforeUnmount, ref } from 'vue';

const activeForms = new Set();

export function confirmUnsavedForms() {
  return ![...activeForms].some(form => form.value)
    || window.confirm('报名资料尚未提交，离开后本次填写内容将丢失。确定离开吗？');
}

export function useUnsavedForm() {
  const dirty = ref(false);
  activeForms.add(dirty);
  function beforeUnload(event) {
    if (!dirty.value) return;
    event.preventDefault();
    event.returnValue = '';
  }
  window.addEventListener('beforeunload', beforeUnload);
  onBeforeUnmount(() => {
    activeForms.delete(dirty);
    window.removeEventListener('beforeunload', beforeUnload);
  });
  return { dirty, markDirty: () => { dirty.value = true; }, markSaved: () => { dirty.value = false; } };
}
