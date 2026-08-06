import { computed, ref } from "vue";

import { api, setPasswordChangeRequiredHandler, setUnauthorizedHandler } from "../lib/api.js";
import { organizationAccessFor } from "./access.js";

const user = ref(null);
const organizations = ref([]);
const accountEvents = ref([]);
const restoring = ref(true);
const organizationAccess = computed(() => organizationAccessFor(user.value, organizations.value));

function setUser(nextUser, nextOrganizations = organizations.value) {
  user.value = nextUser || null;
  organizations.value = Array.isArray(nextOrganizations) ? nextOrganizations : [];
}

function clear() {
  user.value = null;
  organizations.value = [];
  accountEvents.value = [];
}

async function loadAccountEvents() {
  const payload = await api("/api/me/events");
  accountEvents.value = Array.isArray(payload?.rows) ? payload.rows : [];
  return accountEvents.value;
}

function requirePasswordChange() {
  if (user.value) user.value = { ...user.value, mustChangePassword: true };
}

setUnauthorizedHandler(clear);
setPasswordChangeRequiredHandler(requirePasswordChange);

async function restore() {
  restoring.value = true;
  try {
    const payload = await api("/api/auth/me");
    setUser(payload.user, payload.organizations);
    return payload.user;
  } catch (error) {
    if (error.status === 401) clear();
    return null;
  } finally {
    restoring.value = false;
  }
}

async function login(credentials) {
  const payload = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(credentials)
  });
  setUser(payload.user, payload.organizations);
  return payload.user;
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // Local state must always be cleared, including when the network is down.
  } finally {
    clear();
  }
}

export function useSession() {
  return { user, organizations, organizationAccess, accountEvents, restoring, restore, login, logout, setUser, clear, loadAccountEvents };
}
