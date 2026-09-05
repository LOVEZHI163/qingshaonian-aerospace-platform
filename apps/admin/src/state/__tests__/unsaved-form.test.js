import { mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { useUnsavedForm, confirmUnsavedForms } from '../unsaved-form.js';

afterEach(() => vi.restoreAllMocks());
it('protects navigation and reload, and releases the guard after save or unmount', async () => {
  let form;
  const wrapper = mount({ setup() { form = useUnsavedForm(); return form; }, template: '<input @input="markDirty" />' });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  expect(confirmUnsavedForms()).toBe(true);
  await wrapper.get('input').setValue('队员甲');
  expect(confirmUnsavedForms()).toBe(false);
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  confirm.mockReturnValue(true);
  expect(confirmUnsavedForms()).toBe(true);
  form.markSaved();
  expect(confirmUnsavedForms()).toBe(true);
  const savedUnload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(savedUnload);
  expect(savedUnload.defaultPrevented).toBe(false);
  form.markDirty();
  wrapper.unmount();
  confirm.mockReturnValue(false);
  expect(confirmUnsavedForms()).toBe(true);
});
