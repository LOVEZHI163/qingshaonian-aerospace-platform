import assert from 'node:assert/strict';
import test from 'node:test';
import { publicEventPayload } from '../src/services/events.js';

const now = () => new Date('2026-09-05T00:00:00Z');
function fixture() {
  return {
    events: ['E1', 'E2'].map(id => ({ id, name: id, status: 'published', isCurrent: false, registrationMode: 'automatic', registrationStartAt: '2026-08-01T00:00:00Z', registrationEndAt: '2026-11-01T00:00:00Z' })),
    eventPublicProfiles: ['E1', 'E2'].map((eventId, displayOrder) => ({ eventId, displayOrder, isVisible: true })),
    siteSettings: { featuredEventId: 'E2' }, projects: [{ id: 'P1', eventId: 'E1', enabled: true }, { id: 'P2', eventId: 'E2', enabled: true }]
  };
}
test('public default follows the homepage pinned event without legacy isCurrent', () => {
  const payload = publicEventPayload(fixture(), now);
  assert.equal(payload.event.id, 'E2');
  assert.deepEqual(payload.projects.map(p => p.id), ['P2']);
});
test('an empty public catalog is a valid empty state', () => {
  const payload = publicEventPayload({ events: [], projects: [], eventPublicProfiles: [] }, now);
  assert.equal(payload.event.name, undefined);
  assert.deepEqual(payload.projects, []);
  assert.equal(payload.registrationWindow.open, false);
});
